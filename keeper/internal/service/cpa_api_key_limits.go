package service

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"cpa-usage-keeper/internal/entities"
	"cpa-usage-keeper/internal/pricing"
	"cpa-usage-keeper/internal/repository"
	repodto "cpa-usage-keeper/internal/repository/dto"

	"gorm.io/gorm"
	"gorm.io/plugin/dbresolver"
)

const microusdPerUSD = 1_000_000

var ErrInvalidLimit = errors.New("invalid api key limit")

type CPAAPIKeyLimitUsage struct {
	QuotaUsedMicrousd   int64
	Rate5hUsedMicrousd  int64
	RateDayUsedMicrousd int64
	Rate7dUsedMicrousd  int64
	CostAvailable       bool
}

type CPAAPIKeyLimitSnapshot struct {
	Key   entities.CPAAPIKey
	Usage CPAAPIKeyLimitUsage
}

type CPAAPIKeyLimitDecision struct {
	Allowed bool
	Code    string
	Message string
}

type CPAAPIKeyLimitProvider interface {
	ListCPAAPIKeyLimitSnapshots(ctx context.Context) ([]CPAAPIKeyLimitSnapshot, error)
	UpdateCPAAPIKeyLimits(ctx context.Context, id int64, limits entities.CPAAPIKeyLimits) (CPAAPIKeyLimitSnapshot, error)
	ResetCPAAPIKeyRateLimitUsage(ctx context.Context, id int64) (CPAAPIKeyLimitSnapshot, error)
	CheckCPAAPIKeyLimits(ctx context.Context, apiKey string) (CPAAPIKeyLimitDecision, error)
}

type cpaAPIKeyLimitService struct {
	db          *gorm.DB
	recentUsage *repository.UsageRecentEventCache
	pricing     *pricing.Catalog
	now         func() time.Time
}

type CPAAPIKeyLimitServiceOptions struct {
	RecentUsage    *repository.UsageRecentEventCache
	PricingCatalog *pricing.Catalog
	Now            func() time.Time
}

func NewCPAAPIKeyLimitService(db *gorm.DB, options CPAAPIKeyLimitServiceOptions) CPAAPIKeyLimitProvider {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &cpaAPIKeyLimitService{
		db:          db,
		recentUsage: options.RecentUsage,
		pricing:     requirePricingCatalog(options.PricingCatalog),
		now:         now,
	}
}

func (s *cpaAPIKeyLimitService) ListCPAAPIKeyLimitSnapshots(ctx context.Context) ([]CPAAPIKeyLimitSnapshot, error) {
	rows, err := repository.ListActiveCPAAPIKeys(s.db.WithContext(usageServiceContext(ctx)))
	if err != nil {
		return nil, err
	}
	snapshots := make([]CPAAPIKeyLimitSnapshot, 0, len(rows))
	now := s.now()
	for _, row := range rows {
		snapshot, snapshotErr := s.snapshot(ctx, row, now)
		if snapshotErr != nil {
			return nil, snapshotErr
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, nil
}

func (s *cpaAPIKeyLimitService) UpdateCPAAPIKeyLimits(ctx context.Context, id int64, limits entities.CPAAPIKeyLimits) (CPAAPIKeyLimitSnapshot, error) {
	if id <= 0 {
		return CPAAPIKeyLimitSnapshot{}, ErrInvalidID
	}
	if err := validateCPAAPIKeyLimits(limits); err != nil {
		return CPAAPIKeyLimitSnapshot{}, err
	}
	if err := repository.UpdateCPAAPIKeyLimits(s.db.WithContext(usageServiceContext(ctx)), id, limits); err != nil {
		return CPAAPIKeyLimitSnapshot{}, err
	}
	row, err := repository.FindActiveCPAAPIKeyByID(s.db.WithContext(usageServiceContext(ctx)).Clauses(dbresolver.Write), id)
	if err != nil {
		return CPAAPIKeyLimitSnapshot{}, err
	}
	return s.snapshot(ctx, row, s.now())
}

func (s *cpaAPIKeyLimitService) ResetCPAAPIKeyRateLimitUsage(ctx context.Context, id int64) (CPAAPIKeyLimitSnapshot, error) {
	if id <= 0 {
		return CPAAPIKeyLimitSnapshot{}, ErrInvalidID
	}
	now := s.now()
	if err := repository.ResetCPAAPIKeyRateLimitUsage(s.db.WithContext(usageServiceContext(ctx)), id, now); err != nil {
		return CPAAPIKeyLimitSnapshot{}, err
	}
	row, err := repository.FindActiveCPAAPIKeyByID(s.db.WithContext(usageServiceContext(ctx)).Clauses(dbresolver.Write), id)
	if err != nil {
		return CPAAPIKeyLimitSnapshot{}, err
	}
	return s.snapshot(ctx, row, now)
}

func (s *cpaAPIKeyLimitService) CheckCPAAPIKeyLimits(ctx context.Context, apiKey string) (CPAAPIKeyLimitDecision, error) {
	row, err := repository.FindActiveCPAAPIKeyByValue(s.db.WithContext(usageServiceContext(ctx)), apiKey)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return allowedCPAAPIKeyLimitDecision(), nil
	}
	if err != nil {
		return CPAAPIKeyLimitDecision{}, err
	}
	now := s.now()
	if row.ExpiresAt != nil && !now.Before(*row.ExpiresAt) {
		return CPAAPIKeyLimitDecision{Code: "api_key_expired", Message: "API key has expired"}, nil
	}
	if row.QuotaLimitMicrousd == 0 && (!row.RateLimitEnabled || (row.RateLimit5hMicrousd == 0 && row.RateLimitDayMicrousd == 0 && row.RateLimit7dMicrousd == 0)) {
		return allowedCPAAPIKeyLimitDecision(), nil
	}
	snapshot, err := s.snapshot(ctx, row, now)
	if err != nil {
		return CPAAPIKeyLimitDecision{}, err
	}
	if !snapshot.Usage.CostAvailable {
		return CPAAPIKeyLimitDecision{Code: "pricing_unavailable", Message: "Usage cost cannot be calculated; configure model pricing first"}, nil
	}
	if row.QuotaLimitMicrousd > 0 && snapshot.Usage.QuotaUsedMicrousd >= row.QuotaLimitMicrousd {
		return CPAAPIKeyLimitDecision{Code: "quota_exceeded", Message: "API key quota has been reached"}, nil
	}
	if row.RateLimitEnabled {
		if row.RateLimit5hMicrousd > 0 && snapshot.Usage.Rate5hUsedMicrousd >= row.RateLimit5hMicrousd {
			return CPAAPIKeyLimitDecision{Code: "rate_limit_exceeded", Message: "API key 5-hour spending limit has been reached"}, nil
		}
		if row.RateLimitDayMicrousd > 0 && snapshot.Usage.RateDayUsedMicrousd >= row.RateLimitDayMicrousd {
			return CPAAPIKeyLimitDecision{Code: "rate_limit_exceeded", Message: "API key daily spending limit has been reached"}, nil
		}
		if row.RateLimit7dMicrousd > 0 && snapshot.Usage.Rate7dUsedMicrousd >= row.RateLimit7dMicrousd {
			return CPAAPIKeyLimitDecision{Code: "rate_limit_exceeded", Message: "API key 7-day spending limit has been reached"}, nil
		}
	}
	return allowedCPAAPIKeyLimitDecision(), nil
}

func allowedCPAAPIKeyLimitDecision() CPAAPIKeyLimitDecision {
	return CPAAPIKeyLimitDecision{Allowed: true}
}

func validateCPAAPIKeyLimits(limits entities.CPAAPIKeyLimits) error {
	for _, value := range []int64{limits.QuotaLimitMicrousd, limits.RateLimit5hMicrousd, limits.RateLimitDayMicrousd, limits.RateLimit7dMicrousd} {
		if value < 0 {
			return ErrInvalidLimit
		}
	}
	return nil
}

func (s *cpaAPIKeyLimitService) snapshot(ctx context.Context, row entities.CPAAPIKey, now time.Time) (CPAAPIKeyLimitSnapshot, error) {
	dayStart := time.Date(now.In(time.Local).Year(), now.In(time.Local).Month(), now.In(time.Local).Day(), 0, 0, 0, 0, time.Local)
	starts := []time.Time{row.CreatedAt, now.Add(-5 * time.Hour), dayStart, now.Add(-7 * 24 * time.Hour)}
	if row.RateLimitResetAt != nil {
		for index := 1; index < len(starts); index++ {
			if row.RateLimitResetAt.After(starts[index]) {
				starts[index] = *row.RateLimitResetAt
			}
		}
	}
	usage := CPAAPIKeyLimitUsage{CostAvailable: true}
	values := []*int64{&usage.QuotaUsedMicrousd, &usage.Rate5hUsedMicrousd, &usage.RateDayUsedMicrousd, &usage.Rate7dUsedMicrousd}
	for index, start := range starts {
		cost, available, err := s.usageCost(ctx, row.APIKey, start, now)
		if err != nil {
			return CPAAPIKeyLimitSnapshot{}, err
		}
		usage.CostAvailable = usage.CostAvailable && available
		*values[index] = cost
	}
	return CPAAPIKeyLimitSnapshot{Key: row, Usage: usage}, nil
}

func (s *cpaAPIKeyLimitService) usageCost(ctx context.Context, apiKey string, start, end time.Time) (int64, bool, error) {
	if !start.Before(end) {
		return 0, true, nil
	}
	overview, err := repository.BuildUsageOverviewWithFilterAndRecentCache(s.db.WithContext(usageServiceContext(ctx)), repodto.UsageQueryFilter{
		Range: "api-key-limit", StartTime: &start, EndTime: &end, EndExclusive: true, QueryNow: &end, APIGroupKey: apiKey,
	}, s.recentUsage, s.pricing.NewResolver())
	if err != nil {
		return 0, false, err
	}
	microusd, err := costToMicrousd(overview.Summary.TotalCost)
	if err != nil {
		return 0, false, err
	}
	return microusd, overview.Summary.CostAvailable, nil
}

func costToMicrousd(cost float64) (int64, error) {
	if math.IsNaN(cost) || math.IsInf(cost, 0) || cost < 0 || cost > float64(math.MaxInt64)/microusdPerUSD {
		return 0, fmt.Errorf("invalid calculated usage cost")
	}
	return int64(math.Ceil(cost * microusdPerUSD)), nil
}

func USDToMicrousd(value float64) (int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > float64(math.MaxInt64)/microusdPerUSD {
		return 0, ErrInvalidLimit
	}
	return int64(math.Round(value * microusdPerUSD)), nil
}

func MicrousdToUSD(value int64) float64 {
	return float64(value) / microusdPerUSD
}
