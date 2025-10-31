Rails.application.routes.draw do
  namespace :admin do
    resources :submissions, only: [ :index, :show ]
    resources :jobs, only: [ :index, :create ]
  end

  # Mission Control - authentication handled by custom constraint
  mount MissionControl::Jobs::Engine, at: "/admin/mission_control"

  # Standings (leaderboard)
  resources :standings, only: [ :index ]

  # Submissions routes
  resources :submissions, only: [ :index, :show, :new, :create, :update ]

  # OAuth authentication routes
  get "/auth/:provider/callback", to: "sessions#create"
  get "/auth/failure", to: "sessions#failure"
  delete "/logout", to: "sessions#destroy", as: :logout

  # Set root to standings page
  root "standings#index"

  # Reveal health status on /up that returns 200 if the app boots with no exceptions, otherwise 500.
  # Can be used by load balancers and uptime monitors to verify that the app is live.
  get "up" => "rails/health#show", as: :rails_health_check

  # Render dynamic PWA files from app/views/pwa/* (remember to link manifest in application.html.erb)
  # get "manifest" => "rails/pwa#manifest", as: :pwa_manifest
  # get "service-worker" => "rails/pwa#service_worker", as: :pwa_service_worker
end
