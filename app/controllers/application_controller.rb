class ApplicationController < ActionController::Base
  # Only allow modern browsers supporting webp images, web push, badges, import maps, CSS nesting, and CSS :has.
  allow_browser versions: :modern

  # Changes to the importmap will invalidate the etag for HTML responses
  stale_when_importmap_changes

  # Make current_user available in views
  helper_method :current_user

  private

  def current_user
    @current_user ||= User.find_by(id: session[:user_id]) if session[:user_id]
  end

  def authenticate_user
    # Check if user is already authenticated via session
    if session[:user_id].present?
      @current_user = User.find_by(id: session[:user_id])
      return if @current_user

      # Clear invalid session
      reset_session
    elsif params[:token].present?
      token_data = JwtService.verify(params[:token])
      unless token_data
        render json: { error: "Invalid or expired token" }, status: :unauthorized
        return
      end

      @current_user = User.find_or_create_by(
        discord_user_id: token_data[:user_id],
        discord_username: token_data[:username]
      )

      session[:user_id] = @current_user.id
    else
      render json: { error: "Authentication required" }, status: :unauthorized
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
