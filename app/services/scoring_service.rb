class ScoringService
  # Calculate standings for a specific week
  # @param week [Integer] NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Array<Hash>] Array of standings with username, correct_picks, tiebreaker
  def self.calculate_standings(week:, season_type: 2)
    # Fetch actual results from ESPN
    scoreboard = EspnScoreboard.new(week: week, season_type: season_type)
    results = scoreboard.results
    return [] if results.empty?

    # Get all submissions for this week
    submissions = Submission.includes(:user).where(week: week)

    standings = submissions.map do |submission|
      correct_picks = calculate_correct_picks(submission, results)

      {
        user_id: submission.user.id,
        discord_user_id: submission.user.discord_user_id,
        username: submission.user.discord_username,
        correct_picks: correct_picks,
        total_picks: submission.picks.size,
        tiebreaker: submission.tiebreaker,
        submission_id: submission.id
      }
    end

    # Sort by correct picks (desc), then by tiebreaker accuracy if needed
    standings.sort_by { |s| [ -s[:correct_picks], s[:tiebreaker] ] }
  end

  # Calculate correct picks for a single submission
  # @param submission [Submission] The user's submission
  # @param results [Hash] Map of competition_id => winning_team_id
  # @return [Integer] Number of correct picks
  def self.calculate_correct_picks(submission, results)
    submission.picks.count do |competition_id, selected_team_id|
      selected_team_id == results[competition_id]
    end
  end

  # Get detailed scoring breakdown for a user's submission
  # @param submission [Submission] The user's submission
  # @param week [Integer] NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Detailed breakdown with picks, results, and correctness
  def self.submission_breakdown(submission, week:, season_type: 2)
    # Fetch game data and results
    scoreboard = EspnScoreboard.new(week: week, season_type: season_type)
    results = scoreboard.results

    picks_breakdown = submission.picks.map do |competition_id, selected_team_id|
      game = scoreboard.games.find { |g| g[:competition_id] == competition_id }
      winning_team = results[competition_id]

      {
        competition_id: competition_id,
        selected_team_id: selected_team_id,
        winning_team_id: winning_team,
        correct: winning_team && selected_team_id == winning_team,
        game: game
      }
    end

    {
      user: submission.user.discord_username,
      week: week,
      tiebreaker: submission.tiebreaker,
      total_picks: picks_breakdown.count,
      correct_picks: picks_breakdown.count { |p| p[:correct] },
      picks: picks_breakdown
    }
  end

  # Check if a submission has any picks for games that have already started
  # @param picks_data [Hash] Hash of competition_id => selected_team_id
  # @param week [Integer] NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Map of competition_id => started (boolean)
  def self.validate_pick_timing(picks_data, week:, season_type: 2)
    scoreboard = EspnScoreboard.new(week: week, season_type: season_type)
    return {} unless scoreboard.raw_scoreboard

    validation = {}
    picks_data.each do |competition_id, _team_id|
      game = scoreboard.games.find { |g| g[:competition_id] == competition_id }
      next unless game

      # Game has started if status is not "STATUS_SCHEDULED"
      validation[competition_id] = game[:status] != "STATUS_SCHEDULED"
    end

    validation
  end

  # Filter out picks for games that have already started
  # @param picks_data [Hash] Hash of competition_id => selected_team_id
  # @param week [Integer] NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Filtered picks (only for un-started games)
  def self.filter_valid_picks(picks_data, week:, season_type: 2)
    validation = validate_pick_timing(picks_data, week: week, season_type: season_type)

    picks_data.reject do |competition_id, _|
      validation[competition_id] == true # Reject started games
    end
  end
end
