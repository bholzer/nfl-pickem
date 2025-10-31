class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses
  stale_when_importmap_changes

  # Make current_user and logged_in? available in views
  helper_method :current_user, :logged_in?

  private

  def current_user
    @current_user ||= User.find_by(id: session[:user_id]) if session[:user_id]
  end

  def logged_in?
    current_user.present?
  end

  def authenticate_user
    # Check if user is already authenticated via session
    if session[:user_id].present?
      @current_user = User.find_by(id: session[:user_id])
      return if @current_user

      # Clear invalid session
      reset_session
    elsif params[:token].present?
      # JWT token authentication (for Discord DM submission links)
      token_data = JwtService.verify(params[:token])
      unless token_data
        redirect_to sign_in_path, alert: "Invalid or expired token. Please sign in."
        return
      end

      @current_user = User.find_or_create_by(
        discord_user_id: token_data[:user_id],
        discord_username: token_data[:username]
      )

      session[:user_id] = @current_user.id
      return
    end

    # No authentication found, redirect to sign-in
    unless @current_user
      redirect_to sign_in_path, alert: "Please sign in to continue."
      false
    end
  end

  def require_admin
    unless @current_user&.admin?
      render json: { error: "Admin access required" }, status: :forbidden
      false
    end
  end
end
