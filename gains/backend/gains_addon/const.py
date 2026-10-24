"""Constants for the Gains add-on (carried over from the integration)."""
from __future__ import annotations

DOMAIN = "gains"
STORAGE_VERSION = 1
STORAGE_KEY = "gains_data"

UNITS = ("imperial", "metric")
DEFAULT_UNITS = "imperial"

EXPERIENCE_LEVELS = ("kids", "beginner", "novice", "intermediate", "advanced")

ACTIVITY_LEVELS = ("sedentary", "lightly_active", "active", "very_active")

# Rest-period timer between sets, in seconds -- a fixed choice list rather
# than a free number so the picker (both the panel's and the dev-tools
# service UI's) stays a simple select.
REST_TIMER_OPTIONS = (45, 60, 90, 120)
DEFAULT_REST_TIMER_SECONDS = 60

ATTR_PROFILE_ID = "profile_id"
ATTR_HA_USER_ID = "ha_user_id"
ATTR_DISPLAY_NAME = "display_name"
ATTR_UNITS = "units"
ATTR_EXPERIENCE_LEVEL = "experience_level"
ATTR_ACTIVITY_LEVEL = "activity_level"
ATTR_PREFERRED_DURATION_MINUTES = "preferred_duration_minutes"
ATTR_REST_TIMER_SECONDS = "rest_timer_seconds"
ATTR_IS_ADMIN = "is_admin"
ATTR_ONBOARDING_COMPLETE = "onboarding_complete"
ATTR_CREATED_AT = "created_at"
ATTR_UPDATED_AT = "updated_at"
ATTR_WORKOUTS = "workouts"
ATTR_RUNS = "runs"
ATTR_PERSONAL_RECORDS = "personal_records"
ATTR_AI_CONVERSATION = "ai_conversation"
ATTR_GYM_PROFILE_ID = "gym_profile_id"
ATTR_GYM_PROFILES = "gym_profiles"
ATTR_LINKED_PROFILES = "linked_profiles"
ATTR_LINKABLE_PROFILES = "linkable_profiles"
ATTR_SHARE_TARGETS = "share_targets"
ATTR_INCOMING_SHARES = "incoming_shares"

SERVICE_ENSURE_PROFILE = "ensure_profile"
SERVICE_UPDATE_PROFILE = "update_profile"
SERVICE_CREATE_WORKOUT = "create_workout"
SERVICE_START_WORKOUT = "start_workout"
SERVICE_LOG_SET = "log_set"
SERVICE_LOG_EXERCISE_EFFORT = "log_exercise_effort"
SERVICE_COMPLETE_WORKOUT = "complete_workout"
SERVICE_SKIP_WORKOUT = "skip_workout"
SERVICE_DELETE_WORKOUT = "delete_workout"
SERVICE_REMOVE_EXERCISE = "remove_exercise"
SERVICE_REPLACE_EXERCISE = "replace_exercise"
SERVICE_CREATE_RUN = "create_run"
SERVICE_LOG_RUN = "log_run"
SERVICE_SKIP_RUN = "skip_run"
SERVICE_CREATE_GYM_PROFILE = "create_gym_profile"
SERVICE_UPDATE_GYM_PROFILE = "update_gym_profile"
SERVICE_DELETE_GYM_PROFILE = "delete_gym_profile"
SERVICE_SELECT_GYM_PROFILE = "select_gym_profile"
SERVICE_AI_CHAT = "ai_chat"
SERVICE_LINK_ACCOUNT = "link_account"
SERVICE_UNLINK_ACCOUNT = "unlink_account"
SERVICE_SHARE_WORKOUT = "share_workout"
SERVICE_SHARE_RUN = "share_run"
SERVICE_SHARE_PROGRAM = "share_program"
SERVICE_RESPOND_SHARE = "respond_share"

# Phase 2 (Strength MVP): manual workout builder + active workout logging.
# Deterministic planning, sport profiles, etc. are later phases -- see the
# retired design package.
WORKOUT_STATUSES = ("planned", "active", "completed", "skipped")
EFFORT_LEVELS = ("easy", "moderate", "hard", "max")

# Run (Strength MVP's running counterpart): a planned run gets logged with
# actual distance/duration once done -- no separate "active" state, since a
# run (unlike a multi-exercise strength workout) is a single continuous
# effort rather than something logged set-by-set while in progress.
RUN_STATUSES = ("planned", "completed", "skipped")
RUN_TYPES = ("easy", "tempo", "interval", "long")

# AI Coach (partial Phase 8): AI performs conversational onboarding and
# proposes workouts; it never writes data directly. Every proposal is
# validated the same way a manual gains.create_workout call is (exercise_id
# against the library) before the user can accept it.
#
# Provider, API keys and models are add-on options (Settings > Add-ons >
# Gains > Configuration - see config.py), falling back to whatever the old
# integration's options flow had saved (migrate.py imports it once).
#
# Each provider's model is a free-text field (not a fixed enum) so a model
# name going stale after this was built doesn't need a code change to fix.
CONF_AI_PROVIDER = "ai_provider"
AI_PROVIDERS = ("anthropic", "openai")
DEFAULT_AI_PROVIDER = "anthropic"

CONF_ANTHROPIC_API_KEY = "anthropic_api_key"
CONF_ANTHROPIC_MODEL = "anthropic_model"
DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5"

CONF_OPENAI_API_KEY = "openai_api_key"
CONF_OPENAI_MODEL = "openai_model"
DEFAULT_OPENAI_MODEL = "gpt-4o"

AI_ROLE_USER = "user"
AI_ROLE_ASSISTANT = "assistant"
