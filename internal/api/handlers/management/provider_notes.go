package management

import (
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

const maxProviderNoteLength = 200

type providerNotePatch struct {
	Provider    string `json:"provider"`
	ConfigIndex int    `json:"config-index"`
	KeyIndex    *int   `json:"key-index"`
	Note        string `json:"note"`
}

func (h *Handler) PatchProviderNote(c *gin.Context) {
	var request providerNotePatch
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body"})
		return
	}
	request.Provider = strings.TrimSpace(request.Provider)
	request.Note = strings.TrimSpace(request.Note)
	if utf8.RuneCountInString(request.Note) > maxProviderNoteLength || strings.IndexFunc(request.Note, unicode.IsControl) >= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "note must be a single line with at most 200 characters"})
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cfg == nil || !h.setProviderNote(request) {
		c.JSON(http.StatusNotFound, gin.H{"error": "provider credential not found"})
		return
	}
	h.persistLocked(c)
}

func (h *Handler) setProviderNote(request providerNotePatch) bool {
	index := request.ConfigIndex
	if index < 0 {
		return false
	}
	switch request.Provider {
	case "gemini-api-key":
		if index >= len(h.cfg.GeminiKey) {
			return false
		}
		h.cfg.GeminiKey[index].Note = request.Note
	case "interactions-api-key":
		if index >= len(h.cfg.InteractionsKey) {
			return false
		}
		h.cfg.InteractionsKey[index].Note = request.Note
	case "claude-api-key":
		if index >= len(h.cfg.ClaudeKey) {
			return false
		}
		h.cfg.ClaudeKey[index].Note = request.Note
	case "codex-api-key":
		if index >= len(h.cfg.CodexKey) {
			return false
		}
		h.cfg.CodexKey[index].Note = request.Note
	case "xai-api-key":
		if index >= len(h.cfg.XAIKey) {
			return false
		}
		h.cfg.XAIKey[index].Note = request.Note
	case "vertex-api-key":
		if index >= len(h.cfg.VertexCompatAPIKey) {
			return false
		}
		h.cfg.VertexCompatAPIKey[index].Note = request.Note
	case "openai-compatibility":
		if index >= len(h.cfg.OpenAICompatibility) {
			return false
		}
		if request.KeyIndex == nil {
			h.cfg.OpenAICompatibility[index].Note = request.Note
			break
		}
		keyIndex := *request.KeyIndex
		if keyIndex < 0 || keyIndex >= len(h.cfg.OpenAICompatibility[index].APIKeyEntries) {
			return false
		}
		h.cfg.OpenAICompatibility[index].APIKeyEntries[keyIndex].Note = request.Note
	default:
		return false
	}
	return true
}
