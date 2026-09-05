package management

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/config"
)

func TestPatchProviderNotePersistsCredentialNote(t *testing.T) {
	h := &Handler{
		cfg: &config.Config{
			CodexKey: []config.CodexKey{{APIKey: "codex-key", BaseURL: "https://example.com"}},
			OpenAICompatibility: []config.OpenAICompatibility{{
				Name: "compat", BaseURL: "https://compat.example.com",
				APIKeyEntries: []config.OpenAICompatibilityAPIKey{{APIKey: "compat-key"}},
			}},
		},
		configFilePath: writeTestConfigFile(t),
	}

	patchProviderNote(t, h, `{"provider":"codex-api-key","config-index":0,"note":"Primary account"}`)
	if h.cfg.CodexKey[0].Note != "Primary account" {
		t.Fatalf("codex note = %q", h.cfg.CodexKey[0].Note)
	}
	patchProviderNote(t, h, `{"provider":"openai-compatibility","config-index":0,"key-index":0,"note":"Backup account"}`)
	if h.cfg.OpenAICompatibility[0].APIKeyEntries[0].Note != "Backup account" {
		t.Fatalf("compatibility key note = %q", h.cfg.OpenAICompatibility[0].APIKeyEntries[0].Note)
	}
	persisted, err := os.ReadFile(h.configFilePath)
	if err != nil || !strings.Contains(string(persisted), "note: Backup account") {
		t.Fatalf("note was not persisted: %v", err)
	}
}

func TestPatchProviderNoteRejectsInvalidNote(t *testing.T) {
	h := &Handler{cfg: &config.Config{CodexKey: []config.CodexKey{{}}}}
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPatch, "/v0/management/provider-note", strings.NewReader(`{"provider":"codex-api-key","config-index":0,"note":"line one\nline two"}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	h.PatchProviderNote(ctx)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func patchProviderNote(t *testing.T, handler *Handler, body string) {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPatch, "/v0/management/provider-note", strings.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	handler.PatchProviderNote(ctx)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
}
