package service

import (
	"context"
	"errors"
	"testing"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/pricing"
	"cpa-usage-keeper/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestCPAAPIKeyLimitsRejectExpiredAndReachedQuota(t *testing.T) {
	now := time.Date(2026, 9, 7, 10, 5, 0, 0, time.Local)
	db := openCPAAPIKeyLimitTestDB(t)
	key := entities.CPAAPIKey{APIKey: "limited-key", DisplayKey: "limited", CreatedAt: now.Add(-24 * time.Hour)}
	if err := db.Create(&key).Error; err != nil {
		t.Fatal(err)
	}
	service := newCPAAPIKeyLimitTestService(t, db, now)
	expired := now.Add(-time.Minute)
	if _, err := service.UpdateCPAAPIKeyLimits(context.Background(), key.ID, entities.CPAAPIKeyLimits{ExpiresAt: &expired}); err != nil {
		t.Fatal(err)
	}
	decision, err := service.CheckCPAAPIKeyLimits(context.Background(), key.APIKey)
	if err != nil || decision.Allowed || decision.Code != "api_key_expired" {
		t.Fatalf("expired decision = %+v, err = %v", decision, err)
	}

	if err := db.Create(&entities.UsageEvent{APIGroupKey: key.APIKey, Model: "model-a", InputTokens: 1_000_000, TotalTokens: 1_000_000, Timestamp: now.Add(-time.Minute), CreatedAt: now.Add(-time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	service = newCPAAPIKeyLimitTestService(t, db, now)
	if _, err := service.UpdateCPAAPIKeyLimits(context.Background(), key.ID, entities.CPAAPIKeyLimits{QuotaLimitMicrousd: 1_000_000}); err != nil {
		t.Fatal(err)
	}
	decision, err = service.CheckCPAAPIKeyLimits(context.Background(), key.APIKey)
	if err != nil || decision.Allowed || decision.Code != "quota_exceeded" {
		t.Fatalf("quota decision = %+v, err = %v", decision, err)
	}
}

func TestCPAAPIKeyRateLimitResetIgnoresEarlierUsage(t *testing.T) {
	now := time.Date(2026, 9, 7, 10, 5, 0, 0, time.Local)
	db := openCPAAPIKeyLimitTestDB(t)
	key := entities.CPAAPIKey{APIKey: "reset-key", DisplayKey: "reset", CreatedAt: now.Add(-24 * time.Hour)}
	if err := db.Create(&key).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&entities.UsageEvent{APIGroupKey: key.APIKey, Model: "model-a", InputTokens: 1_000_000, TotalTokens: 1_000_000, Timestamp: now.Add(-time.Minute), CreatedAt: now.Add(-time.Minute)}).Error; err != nil {
		t.Fatal(err)
	}
	service := newCPAAPIKeyLimitTestService(t, db, now)
	limits := entities.CPAAPIKeyLimits{RateLimitEnabled: true, RateLimit5hMicrousd: 1_000_000, RateLimitDayMicrousd: 1_000_000, RateLimit7dMicrousd: 1_000_000}
	if _, err := service.UpdateCPAAPIKeyLimits(context.Background(), key.ID, limits); err != nil {
		t.Fatal(err)
	}
	decision, err := service.CheckCPAAPIKeyLimits(context.Background(), key.APIKey)
	if err != nil || decision.Allowed || decision.Code != "rate_limit_exceeded" {
		t.Fatalf("before reset decision = %+v, err = %v", decision, err)
	}
	snapshot, err := service.ResetCPAAPIKeyRateLimitUsage(context.Background(), key.ID)
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Usage.Rate5hUsedMicrousd != 0 || snapshot.Usage.RateDayUsedMicrousd != 0 || snapshot.Usage.Rate7dUsedMicrousd != 0 {
		t.Fatalf("reset usage = %+v", snapshot.Usage)
	}
	decision, err = service.CheckCPAAPIKeyLimits(context.Background(), key.APIKey)
	if err != nil || !decision.Allowed {
		t.Fatalf("after reset decision = %+v, err = %v", decision, err)
	}
}

func TestUSDToMicrousdValidatesInput(t *testing.T) {
	for _, invalid := range []float64{-1, 1e20} {
		if _, err := USDToMicrousd(invalid); !errors.Is(err, ErrInvalidLimit) {
			t.Fatalf("USDToMicrousd(%v) error = %v", invalid, err)
		}
	}
	got, err := USDToMicrousd(1.234567)
	if err != nil || got != 1_234_567 {
		t.Fatalf("USDToMicrousd = %d, %v", got, err)
	}
}

func openCPAAPIKeyLimitTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&entities.CPAAPIKey{}, &entities.UsageEvent{}, &entities.UsageOverviewHourlyStat{}, &entities.UsageOverviewDailyStat{}); err != nil {
		t.Fatal(err)
	}
	return db
}

func cpaAPIKeyLimitTestPricing(t *testing.T) *pricing.Catalog {
	t.Helper()
	one := 1.0
	snapshot, err := pricing.CompileSnapshot([]pricing.ModelConfig{{Pricing: entities.ModelPriceSetting{Model: "model-a", PricingStyle: entities.ModelPricingStyleOpenAI, PromptPricePer1M: 1, PriceMultiplier: &one}}})
	if err != nil {
		t.Fatal(err)
	}
	return pricing.NewCatalog(snapshot)
}

func newCPAAPIKeyLimitTestService(t *testing.T, db *gorm.DB, now time.Time) CPAAPIKeyLimitProvider {
	t.Helper()
	cache, err := repository.NewUsageRecentEventCache(db, repository.UsageRecentEventCacheOptions{Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cache.Close)
	return NewCPAAPIKeyLimitService(db, CPAAPIKeyLimitServiceOptions{RecentUsage: cache, PricingCatalog: cpaAPIKeyLimitTestPricing(t), Now: func() time.Time { return now }})
}
