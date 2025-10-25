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
    central_tz = ActiveSupport::TimeZone["America/Chicago"]

    @raw_scoreboard["events"].map do |event|
      competition = event["competitions"]&.first
      next unless competition

      # Parse UTC time and convert to Central Time
      utc_time = DateTime.parse(event["date"])
      central_time = utc_time.in_time_zone(central_tz)

      {
        competition_id: competition["id"],
        date: central_time,
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

  # Returns map of competition_id => winning_team_id (only for completed games)
  def results
    Hash[
      games.select { |game| game[:status] == "STATUS_FINAL" }.map do |game|
        [ game[:competition_id], game[:winner_id] ]
      end
    ]
  end

  def all_games_complete?
    games.all? { |g| g[:status] == "STATUS_FINAL" }
  end

  def remaining_games
    games.select { |g| g[:status] != "STATUS_FINAL" }
  end

  def monday_night_total
    # Find games on Monday
    monday_games = games.select { |game| game[:date].monday? }
    return nil if monday_games.empty?

    # Only return total if game is final
    return nil unless monday_games.any? { |g| g[:status] == "STATUS_FINAL" }

    home_score = monday_games.map { |g| g[:home_team][:score] }.sum
    away_score = monday_games.map { |g| g[:away_team][:score] }.sum
    home_score + away_score
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
