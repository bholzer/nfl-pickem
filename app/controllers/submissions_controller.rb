class SubmissionsController < ApplicationController
  before_action :authenticate_user, only: [ :index, :new, :create, :update, :show ]
  before_action :set_week, only: [ :new, :create, :update, :show ]
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
    @submission = Submission.find_by(user: @current_user, week: @week)

    unless @submission
      redirect_to new_submission_path(week: @week), alert: "No submission found for this week."
      return
    end

    # Get game data and scoring breakdown
    scoring = ScoringService.new(week: @week)
    @breakdown = scoring.breakdown(@submission)
    @scoreboard = scoring.scoreboard
  end

  def index
    # Show all submissions for the current user
    @submissions = @current_user.submissions.order(week: :desc)
  end

  private

  def set_week
    # Week can come from token (initial access) or params (navigation)
    if params[:token].present?
      token_data = JwtService.verify(params[:token])
      @week = token_data[:week] if token_data
    end

    # Fall back to params or raise error
    @week ||= params[:week]

    unless @week
      render json: { error: "Week parameter required" }, status: :bad_request
    end
  end

  def find_or_initialize_submission
    @submission = Submission.find_or_initialize_by(
      user: @current_user,
      week: @week
    )
  end

  def load_games
    @scoreboard = EspnScoreboard.new(week: @week)
  end

  def submission_params
    params.require(:submission).permit(:tiebreaker, picks: {})
  end

  def save_submission
    @games_locked = @scoreboard.games_started?

    # Prevent editing existing submissions once games have started
    if @submission.persisted? && @games_locked
      redirect_to submission_path(@submission, week: @week),
                  alert: "Cannot edit picks after games have started."
      return
    end

    # Filter out picks for games that have already started (for late submissions)
    valid_picks = ScoringService.filter_valid_picks(
      submission_params[:picks] || {},
      week: @week
    )

    @submission.assign_attributes(submission_params.except(:picks).merge(picks: valid_picks))

    if @submission.save
      redirect_to submission_path(@submission, week: @week),
                  notice: "Picks #{@submission.previously_new_record? ? 'submitted' : 'updated'} successfully!"
    else
      @earliest_game_time = @scoreboard.earliest_game_time
      render :new, status: :unprocessable_entity
    end
  end
end
