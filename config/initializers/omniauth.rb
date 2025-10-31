Rails.application.config.middleware.use OmniAuth::Builder do
  provider :discord,
    Rails.application.credentials.dig(:discord, :client_id),
    Rails.application.credentials.dig(:discord, :client_secret),
    scope: "identify"
end

# Configure OmniAuth to use Rails CSRF protection
OmniAuth.config.allowed_request_methods = [ :post, :get ]
OmniAuth.config.silence_get_warning = true
