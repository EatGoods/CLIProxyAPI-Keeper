package usagekeeper

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
	internallogging "github.com/router-for-me/CLIProxyAPI/v7/internal/logging"
	coreusage "github.com/router-for-me/CLIProxyAPI/v7/sdk/cliproxy/usage"
)

func TestRuntimeEmbedsDashboardAndPersistsUsage(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "config.yaml")
	cfg := &config.Config{
		Port: 18317,
		UsageKeeper: config.UsageKeeperConfig{
			Enabled:  true,
			BasePath: "/usage",
			DataDir:  "keeper-data",
		},
	}

	runtime, err := New(cfg, configPath, "")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() {
		if errClose := runtime.Close(); errClose != nil {
			t.Fatalf("Close() error = %v", errClose)
		}
	})

	recorder := httptest.NewRecorder()
	runtime.embedded.Handler().ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/usage/healthz", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d", recorder.Code, http.StatusOK)
	}

	requestCtx, cancelRequest := context.WithCancel(context.Background())
	ctx := internallogging.WithRequestID(requestCtx, "request-1")
	ctx = internallogging.WithResponseStatusHolder(ctx)
	internallogging.SetResponseStatus(ctx, http.StatusOK)
	cancelRequest()
	runtime.HandleUsage(ctx, coreusage.Record{
		Provider:     "codex",
		ExecutorType: "CodexExecutor",
		Model:        "gpt-5.6-sol",
		APIKey:       "test-api-key",
		AuthIndex:    "auth-1",
		AuthType:     "oauth",
		Source:       "user@example.com",
		RequestedAt:  time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC),
		Detail: coreusage.Detail{
			InputTokens:  10,
			OutputTokens: 5,
			TotalTokens:  15,
		},
	})
	if errFlush := runtime.embedded.Flush(context.Background()); errFlush != nil {
		t.Fatalf("Flush() error = %v", errFlush)
	}
}

func TestRuntimeDoesNotRequireSeparatePassword(t *testing.T) {
	cfg := &config.Config{Port: 18317, UsageKeeper: config.UsageKeeperConfig{Enabled: true}}
	runtime, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"), "")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close() })
}

func TestRuntimeReusesExistingLocalManagementKey(t *testing.T) {
	cfg := &config.Config{Port: 18317, UsageKeeper: config.UsageKeeperConfig{Enabled: true}}
	runtime, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"), "tui-password")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close() })
	if runtime.managementKey != "tui-password" || runtime.registerKey {
		t.Fatalf("runtime management key state = %q, register=%t", runtime.managementKey, runtime.registerKey)
	}
}

func TestRuntimeCreatesEmbeddedAdminSession(t *testing.T) {
	cfg := &config.Config{Port: 18317, UsageKeeper: config.UsageKeeperConfig{Enabled: true}}
	runtime, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"), "management-key")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close() })

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/v0/management/usage-keeper/session", nil)
	runtime.createManagementSession(ctx)
	if recorder.Code != http.StatusOK {
		t.Fatalf("session exchange status = %d, want %d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response struct {
		SessionToken string `json:"session_token"`
	}
	if errDecode := json.Unmarshal(recorder.Body.Bytes(), &response); errDecode != nil || response.SessionToken == "" {
		t.Fatalf("invalid session exchange response: %v body=%s", errDecode, recorder.Body.String())
	}

	sessionRequest := httptest.NewRequest(http.MethodGet, "/usage/api/v1/auth/session", nil)
	sessionRequest.Header.Set("X-CPA-Usage-Keeper-Embed", "cpamc")
	sessionRequest.Header.Set("X-CPA-Usage-Keeper-Embed-Session", response.SessionToken)
	sessionRecorder := httptest.NewRecorder()
	runtime.embedded.Handler().ServeHTTP(sessionRecorder, sessionRequest)
	if !strings.Contains(sessionRecorder.Body.String(), `"authenticated":true`) {
		t.Fatalf("embedded session was not authenticated: %s", sessionRecorder.Body.String())
	}
}

func TestRuntimeStatusUsesBrowserCompatibleTimeZone(t *testing.T) {
	previousLocal := time.Local
	previousTZ, hadTZ := os.LookupEnv("TZ")
	t.Cleanup(func() {
		time.Local = previousLocal
		if hadTZ {
			_ = os.Setenv("TZ", previousTZ)
		} else {
			_ = os.Unsetenv("TZ")
		}
	})
	_ = os.Unsetenv("TZ")
	time.Local = time.FixedZone("Local", 8*60*60)

	cfg := &config.Config{Port: 18317, UsageKeeper: config.UsageKeeperConfig{Enabled: true}}
	runtime, err := New(cfg, filepath.Join(t.TempDir(), "config.yaml"), "management-key")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	t.Cleanup(func() { _ = runtime.Close() })

	token, err := runtime.embedded.CreateAdminSession("127.0.0.1", "test")
	if err != nil {
		t.Fatalf("CreateAdminSession() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/usage/api/v1/status", nil)
	req.Header.Set("X-CPA-Usage-Keeper-Embed", "cpamc")
	req.Header.Set("X-CPA-Usage-Keeper-Embed-Session", token)
	recorder := httptest.NewRecorder()
	runtime.embedded.Handler().ServeHTTP(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var response struct {
		Timezone string `json:"timezone"`
	}
	if errDecode := json.Unmarshal(recorder.Body.Bytes(), &response); errDecode != nil {
		t.Fatalf("decode status: %v body=%s", errDecode, recorder.Body.String())
	}
	if response.Timezone == "" || response.Timezone == "Local" {
		t.Fatalf("timezone = %q, want a browser-compatible IANA timezone", response.Timezone)
	}
}
