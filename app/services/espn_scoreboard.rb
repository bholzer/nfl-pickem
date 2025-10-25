class EspnScoreboard
  include HTTParty
  base_uri "https://site.api.espn.com"

  attr_reader :week, :raw_scoreboard, :season_type

  def self.current_week
    response = get("/apis/site/v2/sports/football/nfl/scoreboard")
    return nil unless response.success?
    response.dig("week", "number")
  end

  def initialize(week: self.class.current_week, season_type: 2)
    @week = week
    @season_type = season_type
    fetch
  end

  def fetch
    response = self.class.get(
      "/apis/site/v2/sports/football/nfl/scoreboard",
      query: {
        seasontype: 2,
        week: @week
      }
    )

    @raw_scoreboard = response.success? ? response.parsed_response : nil
  end

  def games
    @raw_scoreboard["events"].map do |event|
      competition = event["competitions"]&.first
      next unless competition

      {
        competition_id: competition["id"],
        date: DateTime.parse(event["date"]),
        status: event["status"]["type"]["name"], # "STATUS_SCHEDULED", "STATUS_IN_PROGRESS", "STATUS_FINAL"
        status_detail: event["status"]["type"]["detail"],
        home_team: parse_team(competition["competitors"].find { |c| c["homeAway"] == "home" }),
        away_team: parse_team(competition["competitors"].find { |c| c["homeAway"] == "away" }),
        winner_id: determine_winner(competition)
      }
    end.compact
  end

  def games_started?
    games.any? { |game| game[:status] != "STATUS_SCHEDULED" }
  end

  def earliest_game_time
    games.min_by { |game| game[:date] }[:date]
  end

  def results
    # Returns map of competition_id => winning_team_id (only for completed games)
    results = {}
    games.each do |game|
      results[game[:competition_id]] = game[:winner_id] if game[:winner_id]
    end
    results
  end

  private

  def parse_team(competitor)
    return {} unless competitor

    {
      id: competitor["id"],
      name: competitor["team"]["displayName"],
      abbreviation: competitor["team"]["abbreviation"],
      logo: competitor["team"]["logo"],
      score: competitor["score"]&.to_i,
      winner: competitor["winner"]
    }
  end

  def determine_winner(competition)
    return nil unless competition["status"]["type"]["completed"]

    winner = competition["competitors"].find { |c| c["winner"] }
    winner&.dig("id")
  end
end
