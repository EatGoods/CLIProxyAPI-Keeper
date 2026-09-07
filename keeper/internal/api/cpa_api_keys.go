package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/helper"
	"cpa-usage-keeper/internal/service"
	"cpa-usage-keeper/internal/timeutil"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

const maxCPAAPIKeyAliasLength = 128

type cpaAPIKeyResponse struct {
	ID           string  `json:"id"`
	KeyAlias     string  `json:"keyAlias"`
	DisplayKey   string  `json:"displayKey"`
	Label        string  `json:"label"`
	LastSyncedAt *string `json:"lastSyncedAt"`
}

type cpaAPIKeyListResponse struct {
	Items []cpaAPIKeyResponse `json:"items"`
}

type cpaAPIKeySettingsResponse struct {
	ID               string  `json:"id"`
	APIKey           string  `json:"apiKey"`
	KeyAlias         string  `json:"keyAlias"`
	DisplayKey       string  `json:"displayKey"`
	Label            string  `json:"label"`
	LastSyncedAt     *string `json:"lastSyncedAt"`
	QuotaLimitUSD    float64 `json:"quotaLimitUsd"`
	QuotaUsedUSD     float64 `json:"quotaUsedUsd"`
	RateLimitEnabled bool    `json:"rateLimitEnabled"`
	FiveHourLimitUSD float64 `json:"fiveHourLimitUsd"`
	FiveHourUsedUSD  float64 `json:"fiveHourUsedUsd"`
	DailyLimitUSD    float64 `json:"dailyLimitUsd"`
	DailyUsedUSD     float64 `json:"dailyUsedUsd"`
	SevenDayLimitUSD float64 `json:"sevenDayLimitUsd"`
	SevenDayUsedUSD  float64 `json:"sevenDayUsedUsd"`
	RateLimitResetAt *string `json:"rateLimitResetAt"`
	ExpiresAt        *string `json:"expiresAt"`
	CostAvailable    bool    `json:"costAvailable"`
}

type cpaAPIKeySettingsListResponse struct {
	Items []cpaAPIKeySettingsResponse `json:"items"`
}

type cpaAPIKeyOption struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type cpaAPIKeyOptionsResponse struct {
	Options []cpaAPIKeyOption `json:"options"`
}

type updateCPAAPIKeyAliasRequest struct {
	KeyAlias string `json:"keyAlias"`
}

type updateCPAAPIKeyLimitsRequest struct {
	QuotaLimitUSD    float64         `json:"quotaLimitUsd"`
	RateLimitEnabled bool            `json:"rateLimitEnabled"`
	FiveHourLimitUSD float64         `json:"fiveHourLimitUsd"`
	DailyLimitUSD    float64         `json:"dailyLimitUsd"`
	SevenDayLimitUSD float64         `json:"sevenDayLimitUsd"`
	ExpiresAt        json.RawMessage `json:"expiresAt"`
}

func registerCPAAPIKeyRoutes(router gin.IRoutes, provider service.CPAAPIKeyProvider, limitProvider service.CPAAPIKeyLimitProvider) {
	router.GET("/usage/api-keys", func(c *gin.Context) {
		rows, err := listCPAAPIKeyRows(c, provider)
		if err != nil {
			return
		}
		c.JSON(http.StatusOK, cpaAPIKeyListResponse{Items: rows})
	})

	router.GET("/usage/api-keys/settings", func(c *gin.Context) {
		rows, err := listCPAAPIKeySettingsRows(c, provider, limitProvider)
		if err != nil {
			return
		}
		c.JSON(http.StatusOK, cpaAPIKeySettingsListResponse{Items: rows})
	})

	router.GET("/usage/api-keys/options", func(c *gin.Context) {
		rows, err := listCPAAPIKeyOptionRows(c, provider)
		if err != nil {
			return
		}
		c.JSON(http.StatusOK, cpaAPIKeyOptionsResponse{Options: rows})
	})

	router.PATCH("/usage/api-keys/:id", func(c *gin.Context) {
		if provider == nil {
			c.JSON(http.StatusNotImplemented, gin.H{"error": "api key provider is not configured"})
			return
		}
		id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
		if err != nil || id <= 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid api key id"})
			return
		}
		var request updateCPAAPIKeyAliasRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		request.KeyAlias = strings.TrimSpace(request.KeyAlias)
		if err := validateCPAAPIKeyAlias(request.KeyAlias); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		row, err := provider.UpdateCPAAPIKeyAlias(c.Request.Context(), id, request.KeyAlias)
		if err != nil {
			if errors.Is(err, service.ErrInvalidID) {
				c.JSON(http.StatusBadRequest, gin.H{"error": "invalid api key id"})
				return
			}
			if errors.Is(err, gorm.ErrRecordNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "api key not found"})
				return
			}
			writeInternalError(c, "update api key alias failed", err)
			return
		}
		c.JSON(http.StatusOK, toCPAAPIKeyResponse(row))
	})

	router.PATCH("/usage/api-keys/:id/limits", func(c *gin.Context) {
		id, ok := parseCPAAPIKeyID(c, limitProvider)
		if !ok {
			return
		}
		var request updateCPAAPIKeyLimitsRequest
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body"})
			return
		}
		limits, err := request.toLimits()
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		snapshot, err := limitProvider.UpdateCPAAPIKeyLimits(c.Request.Context(), id, limits)
		if !writeCPAAPIKeyLimitError(c, err) {
			return
		}
		c.JSON(http.StatusOK, toCPAAPIKeySettingsResponse(snapshot))
	})

	router.POST("/usage/api-keys/:id/limits/reset", func(c *gin.Context) {
		id, ok := parseCPAAPIKeyID(c, limitProvider)
		if !ok {
			return
		}
		snapshot, err := limitProvider.ResetCPAAPIKeyRateLimitUsage(c.Request.Context(), id)
		if !writeCPAAPIKeyLimitError(c, err) {
			return
		}
		c.JSON(http.StatusOK, toCPAAPIKeySettingsResponse(snapshot))
	})
}

func listCPAAPIKeyRows(c *gin.Context, provider service.CPAAPIKeyProvider) ([]cpaAPIKeyResponse, error) {
	if provider == nil {
		return []cpaAPIKeyResponse{}, nil
	}
	rows, err := provider.ListCPAAPIKeys(c.Request.Context())
	if err != nil {
		writeInternalError(c, "list api keys failed", err)
		return nil, err
	}
	response := make([]cpaAPIKeyResponse, 0, len(rows))
	for _, row := range rows {
		response = append(response, toCPAAPIKeyResponse(row))
	}
	return response, nil
}

func listCPAAPIKeySettingsRows(c *gin.Context, provider service.CPAAPIKeyProvider, limitProvider service.CPAAPIKeyLimitProvider) ([]cpaAPIKeySettingsResponse, error) {
	if limitProvider != nil {
		snapshots, err := limitProvider.ListCPAAPIKeyLimitSnapshots(c.Request.Context())
		if err != nil {
			writeInternalError(c, "list api key settings failed", err)
			return nil, err
		}
		response := make([]cpaAPIKeySettingsResponse, 0, len(snapshots))
		for _, snapshot := range snapshots {
			response = append(response, toCPAAPIKeySettingsResponse(snapshot))
		}
		return response, nil
	}
	if provider == nil {
		return []cpaAPIKeySettingsResponse{}, nil
	}
	rows, err := provider.ListCPAAPIKeys(c.Request.Context())
	if err != nil {
		writeInternalError(c, "list api key settings failed", err)
		return nil, err
	}
	response := make([]cpaAPIKeySettingsResponse, 0, len(rows))
	for _, row := range rows {
		response = append(response, toCPAAPIKeySettingsResponse(service.CPAAPIKeyLimitSnapshot{Key: row, Usage: service.CPAAPIKeyLimitUsage{CostAvailable: true}}))
	}
	return response, nil
}

func listCPAAPIKeyOptionRows(c *gin.Context, provider service.CPAAPIKeyProvider) ([]cpaAPIKeyOption, error) {
	if provider == nil {
		return []cpaAPIKeyOption{}, nil
	}
	rows, err := provider.ListCPAAPIKeys(c.Request.Context())
	if err != nil {
		writeInternalError(c, "list api key options failed", err)
		return nil, err
	}
	response := make([]cpaAPIKeyOption, 0, len(rows))
	for _, row := range rows {
		response = append(response, toCPAAPIKeyOption(row))
	}
	return response, nil
}

func toCPAAPIKeyResponse(row entities.CPAAPIKey) cpaAPIKeyResponse {
	label := helper.CPAAPIKeyDisplayName(row)
	var lastSyncedAt *string
	if row.LastSyncedAt != nil {
		value := timeutil.FormatStorageTime(*row.LastSyncedAt)
		lastSyncedAt = &value
	}
	return cpaAPIKeyResponse{
		ID:           strconv.FormatInt(row.ID, 10),
		KeyAlias:     row.KeyAlias,
		DisplayKey:   helper.CPAAPIKeyMaskedDisplayKey(row),
		Label:        label,
		LastSyncedAt: lastSyncedAt,
	}
}

func toCPAAPIKeySettingsResponse(snapshot service.CPAAPIKeyLimitSnapshot) cpaAPIKeySettingsResponse {
	row := snapshot.Key
	label := helper.CPAAPIKeyDisplayName(row)
	var lastSyncedAt *string
	if row.LastSyncedAt != nil {
		value := timeutil.FormatStorageTime(*row.LastSyncedAt)
		lastSyncedAt = &value
	}
	var rateLimitResetAt, expiresAt *string
	if row.RateLimitResetAt != nil {
		value := timeutil.FormatStorageTime(*row.RateLimitResetAt)
		rateLimitResetAt = &value
	}
	if row.ExpiresAt != nil {
		value := timeutil.FormatStorageTime(*row.ExpiresAt)
		expiresAt = &value
	}
	return cpaAPIKeySettingsResponse{
		ID:               strconv.FormatInt(row.ID, 10),
		APIKey:           row.APIKey,
		KeyAlias:         row.KeyAlias,
		DisplayKey:       helper.CPAAPIKeyMaskedDisplayKey(row),
		Label:            label,
		LastSyncedAt:     lastSyncedAt,
		QuotaLimitUSD:    service.MicrousdToUSD(row.QuotaLimitMicrousd),
		QuotaUsedUSD:     service.MicrousdToUSD(snapshot.Usage.QuotaUsedMicrousd),
		RateLimitEnabled: row.RateLimitEnabled,
		FiveHourLimitUSD: service.MicrousdToUSD(row.RateLimit5hMicrousd),
		FiveHourUsedUSD:  service.MicrousdToUSD(snapshot.Usage.Rate5hUsedMicrousd),
		DailyLimitUSD:    service.MicrousdToUSD(row.RateLimitDayMicrousd),
		DailyUsedUSD:     service.MicrousdToUSD(snapshot.Usage.RateDayUsedMicrousd),
		SevenDayLimitUSD: service.MicrousdToUSD(row.RateLimit7dMicrousd),
		SevenDayUsedUSD:  service.MicrousdToUSD(snapshot.Usage.Rate7dUsedMicrousd),
		RateLimitResetAt: rateLimitResetAt,
		ExpiresAt:        expiresAt,
		CostAvailable:    snapshot.Usage.CostAvailable,
	}
}

func parseCPAAPIKeyID(c *gin.Context, provider service.CPAAPIKeyLimitProvider) (int64, bool) {
	if provider == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "api key limit provider is not configured"})
		return 0, false
	}
	id, err := strconv.ParseInt(strings.TrimSpace(c.Param("id")), 10, 64)
	if err != nil || id <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid api key id"})
		return 0, false
	}
	return id, true
}

func writeCPAAPIKeyLimitError(c *gin.Context, err error) bool {
	if err == nil {
		return true
	}
	if errors.Is(err, service.ErrInvalidID) || errors.Is(err, service.ErrInvalidLimit) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limits must be finite non-negative amounts"})
		return false
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": "api key not found"})
		return false
	}
	writeInternalError(c, "update api key limits failed", err)
	return false
}

func (request updateCPAAPIKeyLimitsRequest) toLimits() (entities.CPAAPIKeyLimits, error) {
	quota, err := service.USDToMicrousd(request.QuotaLimitUSD)
	if err != nil {
		return entities.CPAAPIKeyLimits{}, err
	}
	fiveHour, err := service.USDToMicrousd(request.FiveHourLimitUSD)
	if err != nil {
		return entities.CPAAPIKeyLimits{}, err
	}
	daily, err := service.USDToMicrousd(request.DailyLimitUSD)
	if err != nil {
		return entities.CPAAPIKeyLimits{}, err
	}
	sevenDay, err := service.USDToMicrousd(request.SevenDayLimitUSD)
	if err != nil {
		return entities.CPAAPIKeyLimits{}, err
	}
	expiresAt, err := parseOptionalTime(request.ExpiresAt)
	if err != nil {
		return entities.CPAAPIKeyLimits{}, err
	}
	return entities.CPAAPIKeyLimits{QuotaLimitMicrousd: quota, RateLimitEnabled: request.RateLimitEnabled, RateLimit5hMicrousd: fiveHour, RateLimitDayMicrousd: daily, RateLimit7dMicrousd: sevenDay, ExpiresAt: expiresAt}, nil
}

func parseOptionalTime(raw json.RawMessage) (*time.Time, error) {
	if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
		return nil, nil
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, service.ErrInvalidLimit
	}
	parsed, err := time.Parse(time.RFC3339, strings.TrimSpace(value))
	if err != nil {
		return nil, service.ErrInvalidLimit
	}
	return &parsed, nil
}

func toCPAAPIKeyOption(row entities.CPAAPIKey) cpaAPIKeyOption {
	label := helper.CPAAPIKeyDisplayName(row)
	return cpaAPIKeyOption{
		ID:    strconv.FormatInt(row.ID, 10),
		Label: label,
	}
}

func validateCPAAPIKeyAlias(value string) error {
	if len([]rune(value)) > maxCPAAPIKeyAliasLength {
		return errors.New("keyAlias is too long")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return errors.New("keyAlias cannot contain control characters")
		}
	}
	return nil
}
