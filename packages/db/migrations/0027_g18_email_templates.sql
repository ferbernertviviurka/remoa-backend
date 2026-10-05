-- G18 CCR-035 (D-760): templates and notice types that replace the legacy plain-text e-mails. Additive only.
ALTER TYPE "public"."email_template" ADD VALUE 'support-reply';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'referral-reward';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'referral-invite';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'password-changed';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'welcome';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'onboarding-nudge';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'payment-receipt';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'admin-alert';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'dispute-resolved';--> statement-breakpoint
ALTER TYPE "public"."email_template" ADD VALUE 'landing-waitlist';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'support_received';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'password_changed';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'welcome';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'onboarding_nudge';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'payment_receipt';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'admin_alert';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'dispute_resolved';