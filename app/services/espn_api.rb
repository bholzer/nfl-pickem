class EspnApi
  include HTTParty
  base_uri "https://site.api.espn.com"

  # Fetch games for a specific week
  # @param week [Integer] The NFL week number (1-18 for regular season)
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Parsed response with games data
  def self.fetch_games(week:, season_type: 2)
    response = get(
      "/apis/site/v2/sports/football/nfl/scoreboard",
      query: {
        seasontype: season_type,
        week: week
      }
    )

    return nil unless response.success?
    return {} unless response["events"]

    {
      week: response.dig("week", "number"),
      season_type: response.dig("season", "type"),
      games: parse_games(response["events"])
    }
  end

  # Get the current NFL week based on ESPN's data
  # @return [Integer] Current week number
  def self.current_week
    response = get("/apis/site/v2/sports/football/nfl/scoreboard")
    return 1 unless response.success?

    response.dig("week", "number") || 1
  end

  # Parse individual games from events
  # @param events [Array] Array of game events
  # @return [Array<Hash>] Array of parsed game data
  def self.parse_games(events)
    events.map do |event|
      competition = event["competitions"]&.first
      next unless competition

      {
        competition_id: competition["id"],
        date: event["date"],
        status: event["status"]["type"]["name"], # "STATUS_SCHEDULED", "STATUS_IN_PROGRESS", "STATUS_FINAL"
        status_detail: event["status"]["type"]["detail"],
        home_team: parse_team(competition["competitors"].find { |c| c["homeAway"] == "home" }),
        away_team: parse_team(competition["competitors"].find { |c| c["homeAway"] == "away" }),
        winner_id: determine_winner(competition)
      }
    end.compact
  end

  # Parse team data
  # @param competitor [Hash] Team competitor data
  # @return [Hash] Simplified team data
  def self.parse_team(competitor)
    return {} unless competitor

    {
      id: competitor["id"],
      name: competitor["team"]["displayName"],
      abbreviation: competitor["team"]["abbreviation"],
      logo: competitor["team"]["logo"],
      score: competitor["score"],
      winner: competitor["winner"]
    }
  end

  # Determine the winning team ID from a completed game
  # @param competition [Hash] Competition data
  # @return [String, nil] Winning team ID or nil if game not completed
  def self.determine_winner(competition)
    return nil unless competition["status"]["type"]["completed"]

    winner = competition["competitors"].find { |c| c["winner"] }
    winner&.dig("id")
  end

  # Get results for a specific week (only completed games)
  # @param week [Integer] The NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Map of competition_id => winning_team_id
  def self.fetch_results(week:, season_type: 2)
    data = fetch_games(week: week, season_type: season_type)
    return {} unless data

    results = {}
    data[:games].each do |game|
      results[game[:competition_id]] = game[:winner_id] if game[:winner_id]
    end
    results
  end

  # Check if any games have started for a given week
  # @param week [Integer] The NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Boolean] True if at least one game has started
  def self.any_games_started?(week:, season_type: 2)
    data = fetch_games(week: week, season_type: season_type)
    return false unless data

    data[:games].any? do |game|
      game[:status] != "STATUS_SCHEDULED"
    end
  end

  # Get the earliest game start time for a week
  # @param week [Integer] The NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Time, nil] Earliest game start time or nil
  def self.earliest_game_time(week:, season_type: 2)
    data = fetch_games(week: week, season_type: season_type)
    return nil unless data

    earliest = data[:games].min_by { |game| Time.parse(game[:date]) }
    Time.parse(earliest[:date]) if earliest
  end
end
