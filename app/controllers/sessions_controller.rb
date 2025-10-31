class SessionsController < ApplicationController
  skip_before_action :verify_authenticity_token, only: :create

  def create
    auth = request.env["omniauth.auth"]

    # Find or create user based on Discord ID
    user = User.find_by(discord_user_id: auth["uid"])

    if user
      # User exists, log them in
      session[:user_id] = user.id
      redirect_to root_path, notice: "Successfully logged in as #{user.discord_username}!"
    else
      # User doesn't exist in our system yet
      redirect_to root_path, alert: "Discord account not found. Please contact the pool administrator to be added."
    end
  end

  def destroy
    session[:user_id] = nil
    redirect_to root_path, notice: "You have been logged out."
  end

  def failure
    redirect_to root_path, alert: "Authentication failed. Please try again."
  end
end
