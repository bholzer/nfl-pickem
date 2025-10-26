class StandingsController < ApplicationController
  def index
    # Show standings for a specific week
    @week = params[:week]&.to_i || EspnScoreboard.current_week
    scoring = ScoringService.new(week: @week)
    @standings = scoring.standings
    @scoreboard = scoring.scoreboard
  end
end
