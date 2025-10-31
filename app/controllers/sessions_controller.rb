class SessionsController < ApplicationController
  skip_before_action :verify_authenticity_token, only: :create

  def new
    # Redirect to standings if already logged in
    redirect_to standings_path if logged_in?
  end

  def create
    auth = request.env["omniauth.auth"]

    # Find or create user based on Discord ID
    user = User.find_by(discord_user_id: auth["uid"])

    if user
      # User exists, log them in
      session[:user_id] = user.id
      redirect_to standings_path, notice: "Successfully logged in as #{user.discord_username}!"
    else
      # User doesn't exist in our system yet
      redirect_to sign_in_path, alert: "Discord account not found. Please contact the pool administrator to be added."
    end
  end

  def destroy
    session[:user_id] = nil
    redirect_to sign_in_path, notice: "You have been logged out."
  end

  def failure
    redirect_to sign_in_path, alert: "Authentication failed. Please try again."
  end
end
