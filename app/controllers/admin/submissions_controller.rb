class Admin::SubmissionsController < AdminController
  def index
    @week = params[:week] || EspnScoreboard.current_week
    @submissions = Submission.where(week: @week).includes(:user)
    @scoreboard = EspnScoreboard.new(week: @week)
    @scoring = ScoringService.new(week: @week)

    # Sort submissions by score (descending)
    @submissions = @submissions.sort_by do |submission|
      -@scoring.breakdown(submission)[:correct_picks]
    end
  end

  def show
    @submission = Submission.find(params[:id])
    @week = @submission.week
    @scoring = ScoringService.new(week: @week)
    @breakdown = @scoring.breakdown(@submission)
    @scoreboard = @scoring.scoreboard
  end
end
