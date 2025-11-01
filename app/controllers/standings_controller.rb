class StandingsController < ApplicationController
  before_action :authenticate_user

  def index
    # Show standings for a specific week
    @week = params[:week]&.to_i || EspnScoreboard.current_week
    scoring = ScoringService.new(week: @week)
    @standings = scoring.standings
    @scoreboard = scoring.scoreboard
    @winners = @standings.select { |s| s[:winner] }

    # Show tiebreaker if week is complete and multiple people tied at the top
    if @scoreboard.all_games_complete? && @winners.any?
      winner_correct_picks = @winners.first[:correct_picks]
      tied_at_top = @standings.select { |s| s[:correct_picks] == winner_correct_picks }
      @show_tiebreaker = tied_at_top.size > 1
    else
      @show_tiebreaker = false
    end
  end
end
