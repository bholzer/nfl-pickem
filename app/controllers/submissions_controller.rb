class SubmissionsController < ApplicationController
  before_action :verify_token, only: [ :new, :create, :update, :show ]
  before_action :find_or_initialize_submission, only: [ :new, :create, :update ]
  before_action :load_games, only: [ :new, :create, :update ]

  def new
    @games_locked = @scoreboard.games_started?
    @earliest_game_time = @scoreboard.earliest_game_time
  end

  def create
    save_submission
  end

  def update
    save_submission
  end

  def show
    @submission = Submission.find_by(user: @current_user, week: @token_data[:week])

    unless @submission
      redirect_to new_submission_path(token: params[:token]), alert: "No submission found for this week."
      return
    end

    # Get game data and scoring breakdown
    @breakdown = ScoringService.submission_breakdown(@submission, week: @token_data[:week])
    @scoreboard = EspnScoreboard.new(week: @token_data[:week])
  end

  def index
    # Show standings for a specific week
    week = params[:week]&.to_i || EspnScoreboard.current_week
    @standings = ScoringService.calculate_standings(week: week)
    @week = week
  end

  private

  def verify_token
    token = params[:token]

    unless token
      render json: { error: "Token required" }, status: :unauthorized
      return
    end

    @token_data = JwtService.verify(token)

    unless @token_data
      render json: { error: "Invalid or expired token" }, status: :unauthorized
      return
    end

    # Find or create user based on token data
    @current_user = User.find_or_create_by(
      discord_user_id: @token_data[:user_id],
      discord_username: @token_data[:username]
    )
  end

  def find_or_initialize_submission
    @submission = Submission.find_or_initialize_by(
      user: @current_user,
      week: @token_data[:week]
    )
  end

  def load_games
    @scoreboard = EspnScoreboard.new(week: @token_data[:week])
    @week = @token_data[:week]
  end

  def submission_params
    params.require(:submission).permit(:tiebreaker, picks: {})
  end

  def save_submission
    @games_locked = @scoreboard.games_started?

    # Prevent editing existing submissions once games have started
    if @submission.persisted? && @games_locked
      redirect_to submission_path(@submission, token: params[:token]),
                  alert: "Cannot edit picks after games have started."
      return
    end

    # Filter out picks for games that have already started (for late submissions)
    valid_picks = ScoringService.filter_valid_picks(
      submission_params[:picks] || {},
      week: @token_data[:week]
    )

    @submission.assign_attributes(submission_params.except(:picks).merge(picks: valid_picks))

    if @submission.save
      redirect_to submission_path(@submission, token: params[:token]),
                  notice: "Picks #{@submission.previously_new_record? ? 'submitted' : 'updated'} successfully!"
    else
      @earliest_game_time = @scoreboard.earliest_game_time
      render :new, status: :unprocessable_entity
    end
  end
end
