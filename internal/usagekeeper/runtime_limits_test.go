package usagekeeper

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestEnforceAPIKeyLimitsSkipsRequestsWithoutAuthenticatedPrincipal(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	runtime := &Runtime{}
	router.GET("/test", runtime.enforceAPIKeyLimits, func(c *gin.Context) { c.Status(http.StatusNoContent) })

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/test", nil))
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusNoContent)
	}
}
