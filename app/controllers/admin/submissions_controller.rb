class Admin::SubmissionsController < AdminController
  def index
    @week = params[:week] || EspnScoreboard.current_week
    @submissions = Submission.where(week: @week).includes(:user).order("users.discord_username")
    @scoreboard = EspnScoreboard.new(week: @week)
    @scoring = ScoringService.new(week: @week)
  end

  def show
    @submission = Submission.find(params[:id])
    @week = @submission.week
    @scoring = ScoringService.new(week: @week)
    @breakdown = @scoring.breakdown(@submission)
    @scoreboard = @scoring.scoreboard
  end
end
