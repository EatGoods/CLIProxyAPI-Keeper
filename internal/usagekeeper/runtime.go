package usagekeeper

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"

	keeperembedded "cpa-usage-keeper/embedded"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/api"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/redisqueue"
	"github.com/router-for-me/CLIProxyAPI/v7/sdk/api/handlers"
	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
	log "github.com/sirupsen/logrus"
)

const (
	defaultBasePath = "/usage"
	defaultDataDir  = "usage-keeper"
)

type Runtime struct {
	embedded      *keeperembedded.Runtime
	basePath      string
	managementKey string
	registerKey   bool
}

func New(cfg *config.Config, configPath, localManagementKey string) (*Runtime, error) {
	if cfg == nil || !cfg.UsageKeeper.Enabled {
		return nil, nil
	}
	basePath := normalizeBasePath(cfg.UsageKeeper.BasePath)
	dataDir := strings.TrimSpace(cfg.UsageKeeper.DataDir)
	if dataDir == "" {
		dataDir = defaultDataDir
	}
	if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(filepath.Dir(configPath), dataDir)
	}
	managementKey := strings.TrimSpace(localManagementKey)
	registerKey := managementKey == ""
	if registerKey {
		var err error
		managementKey, err = randomManagementKey()
		if err != nil {
			return nil, fmt.Errorf("generate embedded keeper management key: %w", err)
		}
	}
	embedded, err := keeperembedded.New(keeperembedded.Options{
		BasePath:      basePath,
		WorkDir:       dataDir,
		CPABaseURL:    fmt.Sprintf("http://127.0.0.1:%d", cfg.Port),
		ManagementKey: managementKey,
		LoginPassword: managementKey,
	})
	if err != nil {
		return nil, fmt.Errorf("initialize embedded usage keeper: %w", err)
	}

	cfg.UsageStatisticsEnabled = true
	redisqueue.SetUsageStatisticsEnabled(true)
	runtime := &Runtime{
		embedded:      embedded,
		basePath:      basePath,
		managementKey: managementKey,
		registerKey:   registerKey,
	}
	coreusage.RegisterNamedPlugin("embedded-usage-keeper", runtime)
	return runtime, nil
}

func normalizeBasePath(value string) string {
	basePath := strings.TrimRight(strings.TrimSpace(value), "/")
	if basePath == "" {
		return defaultBasePath
	}
	if !strings.HasPrefix(basePath, "/") {
		return "/" + basePath
	}
	return basePath
}

func randomManagementKey() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

func (r *Runtime) ServerOptions() []api.ServerOption {
	if r == nil || r.embedded == nil {
		return nil
	}
	handler := r.embedded.Handler()
	basePath := r.basePath
	options := []api.ServerOption{
		api.WithRouterConfigurator(func(engine *gin.Engine, _ *handlers.BaseAPIHandler, _ *config.Config) {
			serveKeeper := func(c *gin.Context) {
				rootPath := c.Request.URL.Path == basePath || c.Request.URL.Path == basePath+"/"
				if rootPath && (c.Request.Method == http.MethodGet || c.Request.Method == http.MethodHead) && !strings.EqualFold(c.Query("embed"), "cpamc") {
					c.Redirect(http.StatusFound, "/management.html#/usage")
					return
				}
				gin.WrapH(handler)(c)
			}
			engine.Any(basePath, serveKeeper)
			engine.Any(basePath+"/*path", serveKeeper)
		}),
		api.WithUsageKeeperSessionHandler(r.createManagementSession),
	}
	if r.registerKey {
		options = append(options, api.WithLocalManagementPassword(r.managementKey))
	}
	return options
}

func (r *Runtime) createManagementSession(c *gin.Context) {
	token, err := r.embedded.CreateAdminSession(c.ClientIP(), c.Request.UserAgent())
	if err != nil {
		log.WithError(err).Error("embedded usage keeper could not create management session")
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "could not create usage keeper session"})
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, gin.H{"session_token": token})
}

func (r *Runtime) Start(ctx context.Context) {
	if r == nil || r.embedded == nil {
		return
	}
	r.embedded.Start(ctx)
}

func (r *Runtime) Close() error {
	if r == nil || r.embedded == nil {
		return nil
	}
	return r.embedded.Close()
}

func (r *Runtime) HandleUsage(ctx context.Context, record coreusage.Record) {
	if r == nil || r.embedded == nil {
		return
	}
	payload, err := redisqueue.MarshalUsageRecord(ctx, record)
	if err != nil {
		log.WithError(err).Error("embedded usage keeper could not encode usage record")
		return
	}
	// ponytail: one SQLite inbox write per completed request; batch when measured ingestion throughput requires it.
	persistCtx := context.Background()
	if ctx != nil {
		persistCtx = context.WithoutCancel(ctx)
	}
	if err := r.embedded.Ingest(persistCtx, payload); err != nil {
		log.WithError(err).Error("embedded usage keeper could not persist usage record")
	}
}
