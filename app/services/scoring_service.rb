class ScoringService
  attr_reader :week, :scoreboard, :submissions

  def initialize(week: EspnScoreboard.current_week, season_type: 2)
    @week = week
    @season_type = season_type
    @scoreboard = EspnScoreboard.new(week: week, season_type: season_type)
    @submissions = Submission.includes(:user).where(week: week)
  end

  # Calculate standings with contender analysis and tiebreaker
  # @return [Array<Hash>] Sorted standings with metadata
  def standings
    return [] if @submissions.empty?

    standings_data = build_standings_data
    mark_contenders_and_winners!(standings_data)
    sort_and_rank(standings_data)
  end

  # Generate a detailed breakdown for a single submission
  # @param submission [Submission]
  # @return [Hash] Breakdown with user info, correct picks count, and pick details
  def breakdown(submission)
    picks_with_details = submission.picks.map do |competition_id, selected_team_id|
      game = @scoreboard.games.find { |g| g[:competition_id] == competition_id }
      winning_team_id = @scoreboard.results[competition_id]

      {
        competition_id: competition_id,
        selected_team_id: selected_team_id,
        winning_team_id: winning_team_id,
        correct: selected_team_id == winning_team_id,
        game: game
      }
    end

    {
      week: @week,
      user: submission.user.discord_username,
      correct_picks: count_correct_picks(submission),
      tiebreaker: submission.tiebreaker,
      picks: picks_with_details
    }
  end

  # Class method for filtering valid picks (used during submission)
  # @param picks_data [Hash] Hash of competition_id => selected_team_id
  # @param week [Integer] NFL week number
  # @param season_type [Integer] 2 for regular season, 3 for playoffs
  # @return [Hash] Filtered picks (only for un-started games)
  def self.filter_valid_picks(picks_data, week:, season_type: 2)
    scoreboard = EspnScoreboard.new(week: week, season_type: season_type)
    return picks_data unless scoreboard.raw_scoreboard

    picks_data.reject do |competition_id, _|
      game = scoreboard.games.find { |g| g[:competition_id] == competition_id }
      game && game[:status] != "STATUS_SCHEDULED"
    end
  end

  private

  # Build initial standings data with all calculated fields
  def build_standings_data
    @submissions.map do |submission|
      {
        user: submission.user,
        submission: submission,
        winner: false,
        contender: false,
        correct_picks: count_correct_picks(submission),
        remaining_picks: find_remaining_picks(submission),
        tiebreaker_diff: calculate_tiebreaker_diff(submission)
      }
    end
  end

  # Find picks that are still in play (games not yet completed)
  def find_remaining_picks(submission)
    submission.picks.select do |competition_id, _|
      @scoreboard.remaining_games.any? { |game| game[:competition_id] == competition_id }
    end
  end

  # Calculate absolute difference from actual Monday night total
  def calculate_tiebreaker_diff(submission)
    return nil unless using_tiebreaker?
    (submission.tiebreaker - @scoreboard.monday_night_total).abs
  end

  # Determine if we're using tiebreaker for sorting/winning
  def using_tiebreaker?
    @scoreboard.all_games_complete? && @scoreboard.monday_night_total
  end

  # Mark contenders and winners based on current game state
  def mark_contenders_and_winners!(standings_data)
    leaders = find_leaders(standings_data)
    mark_contenders!(standings_data, leaders)
    mark_winners!(standings_data)
  end

  # Find the leader(s) - those with the most correct picks
  def find_leaders(standings_data)
    max_correct = standings_data.map { |s| s[:correct_picks] }.max
    standings_data.select { |s| s[:correct_picks] == max_correct }
  end

  # Mark who is still a contender (can mathematically win or tie)
  def mark_contenders!(standings_data, leaders)
    standings_data.each do |standing|
      standing[:contender] = leaders.any? { |leader| can_catch_up?(leader, standing) }
    end
  end

  # Mark the winner(s) if we can definitively determine them
  def mark_winners!(standings_data)
    contenders = standings_data.select { |s| s[:contender] }

    if contenders.size == 1
      # Only one person can win - they're the winner
      contenders.first[:winner] = true
    elsif @scoreboard.all_games_complete?
      # All games done - use tiebreaker to determine winner(s)
      mark_tiebreaker_winners!(contenders)
    end
  end

  # When all games are complete, determine winner(s) by tiebreaker proximity
  def mark_tiebreaker_winners!(contenders)
    return if contenders.empty?

    min_diff = contenders.map { |c| c[:tiebreaker_diff] }.min
    winners = contenders.select { |c| c[:tiebreaker_diff] == min_diff }
    winners.each { |w| w[:winner] = true }
  end

  # Sort standings and assign ranks
  def sort_and_rank(standings_data)
    sorted = standings_data.sort_by { |s| sort_key_for(s) }
    assign_ranks(sorted)
  end

  # Generate sort key based on whether tiebreaker is in effect
  def sort_key_for(standing)
    if using_tiebreaker?
      # Sort by correct picks (desc), then tiebreaker proximity (asc)
      [ -standing[:correct_picks], standing[:tiebreaker_diff] ]
    else
      # Sort by correct picks (desc), then tiebreaker guess (desc for display)
      [ -standing[:correct_picks], -standing[:submission].tiebreaker ]
    end
  end

  # Assign ranks, giving same rank to entries with identical sort keys
  def assign_ranks(sorted_standings)
    sorted_standings.each_with_index.reduce([]) do |result, (standing, index)|
      rank = if index.zero?
        1
      elsif same_position?(standing, sorted_standings[index - 1])
        result.last[:rank]
      else
        index + 1
      end

      result << standing.merge(rank: rank)
    end
  end

  # Check if two standings should share the same rank (identical sort keys)
  def same_position?(standing1, standing2)
    sort_key_for(standing1) == sort_key_for(standing2)
  end

  # Count correct picks for a submission
  # @param submission [Submission]
  # @return [Integer]
  def count_correct_picks(submission)
    submission.picks.count do |competition_id, selected_team_id|
      selected_team_id == @scoreboard.results[competition_id]
    end
  end

  # Determine if a trailer can mathematically catch up to a leader
  def can_catch_up?(leader, trailer)
    pick_diff = (leader[:remaining_picks].to_a - trailer[:remaining_picks].to_a).size
    leader_min = leader[:correct_picks]
    trailer_max = trailer[:correct_picks] + pick_diff
    trailer_max >= leader_min
  end
end
