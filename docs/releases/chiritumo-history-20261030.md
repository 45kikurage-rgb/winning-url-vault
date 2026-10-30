# Coupon history for Chiritumo

Show newly accepted Chiritumo URLs grouped by recognized product, specification and redemption place, using the existing analyzer results. Read responses expose category summaries only. A single confirmation hides exactly the displayed snapshot, leaving stored coupon URLs, intake source, other sources, and later arrivals intact. This additive release stores visibility in a separate table and does not change the Vault's existing sorting or winning screens.

Validation: history integration tests cover grouping across expiry dates, source separation, unchanged URL rows after hiding, concurrent arrivals, replay, tampering and origin restrictions. Production release verifies the existing analyzer pipeline, synthetic grouping and hiding, and removes all synthetic coupons before completion.
