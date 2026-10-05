-- G18 CCR-037 (P-323, D-797): profiles.timezone is now written only by the API (PATCH /v1/account/profile), which replans the
-- pending calendar reminders in the same transaction. A direct PostgREST update would move the clock without moving the reminders.
REVOKE UPDATE (timezone) ON public.profiles FROM authenticated;
