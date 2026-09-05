package embedded

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"cpa-usage-keeper/internal/app"
	"cpa-usage-keeper/internal/auth"
	keeperconfig "cpa-usage-keeper/internal/config"
	"cpa-usage-keeper/internal/poller"
)

const embeddedUsageSource = "embedded"

type Options struct {
	BasePath      string
	WorkDir       string
	CPABaseURL    string
	ManagementKey string
	LoginPassword string
}

type Runtime struct {
	app    *app.App
	writer *poller.RepositoryRedisInboxWriter

	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func New(options Options) (*Runtime, error) {
	if err := keeperconfig.ApplyProjectTimeZone(); err != nil {
		return nil, err
	}
	basePath := strings.TrimRight(strings.TrimSpace(options.BasePath), "/")
	if basePath == "" || !strings.HasPrefix(basePath, "/") {
		return nil, fmt.Errorf("keeper base path must start with /")
	}
	workDir := filepath.Clean(strings.TrimSpace(options.WorkDir))
	if workDir == "." || workDir == "" {
		return nil, fmt.Errorf("keeper work directory is required")
	}
	if err := os.MkdirAll(workDir, 0o750); err != nil {
		return nil, fmt.Errorf("create keeper work directory: %w", err)
	}
	if strings.TrimSpace(options.LoginPassword) == "" {
		return nil, fmt.Errorf("keeper login password is required")
	}

	cfg := keeperconfig.Config{
		AppBasePath:             basePath,
		CPABaseURL:              strings.TrimRight(options.CPABaseURL, "/"),
		CPAManagementKey:        options.ManagementKey,
		RedisQueueBatchSize:     keeperconfig.RedisQueueBatchSizeDefault,
		RedisQueueIdleInterval:  time.Second,
		MetadataSyncInterval:    keeperconfig.MetadataSyncIntervalDefault,
		QuotaRefreshWorkerLimit: keeperconfig.QuotaRefreshWorkerLimitDefault,
		WorkDir:                 workDir,
		SQLitePath:              filepath.Join(workDir, "app.db"),
		BackupEnabled:           true,
		BackupDir:               filepath.Join(workDir, "backups"),
		BackupInterval:          24 * time.Hour,
		BackupRetentionDays:     7,
		RequestTimeout:          30 * time.Second,
		LogLevel:                "info",
		LogFileEnabled:          false,
		LogDir:                  filepath.Join(workDir, "logs"),
		LogRetentionDays:        7,
		AuthEnabled:             true,
		LoginPassword:           options.LoginPassword,
		AuthSessionTTL:          7 * 24 * time.Hour,
	}

	keeperApp, err := app.NewEmbeddedWithConfig(cfg)
	if err != nil {
		return nil, err
	}
	return &Runtime{
		app:    keeperApp,
		writer: poller.NewRedisInboxWriter(keeperApp.DB),
	}, nil
}

func (r *Runtime) Handler() http.Handler {
	if r == nil || r.app == nil {
		return http.NotFoundHandler()
	}
	return r.app.Router
}

func (r *Runtime) CreateAdminSession(ip, userAgent string) (string, error) {
	if r == nil || r.app == nil || r.app.AuthSessions == nil {
		return "", fmt.Errorf("keeper auth session manager is unavailable")
	}
	token, _, err := r.app.AuthSessions.CreateWithSourceAndMetadata(auth.SessionSourceEmbed, auth.SessionClientMetadata{
		IP:        ip,
		UserAgent: userAgent,
	})
	return token, err
}

func (r *Runtime) Ingest(ctx context.Context, payload []byte) error {
	if r == nil || r.writer == nil {
		return fmt.Errorf("keeper runtime is not initialized")
	}
	_, err := r.writer.Insert(ctx, embeddedUsageSource, []string{string(payload)}, time.Now())
	return err
}

func (r *Runtime) Flush(ctx context.Context) error {
	if r == nil || r.app == nil {
		return fmt.Errorf("keeper runtime is not initialized")
	}
	processor, ok := r.app.RedisProcess.(*poller.RedisProcessRunner)
	if !ok || processor == nil {
		return fmt.Errorf("keeper usage processor is unavailable")
	}
	_, err := processor.ProcessOnce(ctx)
	return err
}

func (r *Runtime) Start(ctx context.Context) {
	if r == nil || r.app == nil || r.cancel != nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel

	r.start(runCtx, r.app.RedisProcess)
	r.start(runCtx, r.app.CPAErrors)
	r.start(runCtx, r.app.UsageAggregation)
	r.start(runCtx, r.app.Ranking)
	r.start(runCtx, r.app.LocalRanking)
	r.start(runCtx, r.app.Maintenance)
	r.start(runCtx, r.app.MetadataSync)
	if r.app.MetadataSync != nil {
		r.app.MetadataSync.NotifyIngestConnected()
	}
	if r.app.QuotaService != nil {
		r.app.QuotaService.SetRefreshContext(runCtx)
	}
	if r.app.QuotaAutoRefresh != nil {
		r.wg.Add(1)
		go func() {
			defer r.wg.Done()
			_ = r.app.QuotaAutoRefresh.StartAutoRefresh(runCtx)
		}()
	}
	r.start(runCtx, r.app.BackupMaintenance)
}

func (r *Runtime) start(ctx context.Context, runner app.Runner) {
	if runner == nil {
		return
	}
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		_ = runner.Run(ctx)
	}()
}

func (r *Runtime) Close() error {
	if r == nil {
		return nil
	}
	if r.cancel != nil {
		r.cancel()
		r.cancel = nil
	}
	r.wg.Wait()
	if r.app == nil {
		return nil
	}
	err := r.app.Close()
	r.app = nil
	r.writer = nil
	return err
}
