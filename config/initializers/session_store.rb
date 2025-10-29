# Configure session store with 7-day expiration
# This allows users to stay authenticated for a week after clicking their JWT link
Rails.application.config.session_store :cookie_store,
  key: "_nfl_pickem_session",
  expire_after: 31.days
