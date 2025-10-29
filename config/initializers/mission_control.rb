# Configure Mission Control::Jobs to use admin authentication
Rails.application.configure do
  config.mission_control.jobs.base_controller_class = "AdminController"
  config.mission_control.jobs.http_basic_auth_enabled = false
end
