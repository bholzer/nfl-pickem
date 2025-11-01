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

    submission_scores = @submissions.map do |submission|
      {
        user: submission.user,
        submission: submission,
        winner: false,
        correct_picks: count_correct_picks(submission),
        remaining_picks: submission.picks.select do |competition_id, _|
          @scoreboard.remaining_games.any? { |game| game[:competition_id] == competition_id }
        end
      }
    end

    leading_score = submission_scores.max_by { |s| s[:correct_picks] }[:correct_picks]
    leaders = submission_scores.select { |s| s[:correct_picks] == leading_score }

    # A contender is any submission that can catch up to or tie a leader
    submission_scores.each do |sub|
      sub[:contender] = leaders.any? { |leader| can_catch_up?(leader, sub) }
    end

    contenders = submission_scores.select { |s| s[:contender] }

    # Determine winner(s) if possible
    if contenders.size == 1
      contenders.first[:winner] = true
    elsif @scoreboard.all_games_complete?
      monday_night_total = @scoreboard.monday_night_total || 0
      min_tiebreak_diff = contenders.map { |c| (c[:submission].tiebreaker - monday_night_total).abs }.min
      winners = contenders.select { |c| (c[:submission].tiebreaker - monday_night_total).abs == min_tiebreak_diff }
      winners.each { |w| w[:winner] = true }
    end

    # Sort by correct picks (descending), then by tiebreaker proximity if all games complete
    sorted_scores = submission_scores.sort_by do |s|
      if @scoreboard.all_games_complete? && @scoreboard.monday_night_total
        [ -s[:correct_picks], (s[:submission].tiebreaker - @scoreboard.monday_night_total).abs ]
      else
        [ -s[:correct_picks], s[:submission].tiebreaker ]
      end
    end

    # Add ranks (handle ties by comparing correct_picks)
    sorted_scores.each_with_index.reduce([]) do |result, (standing, index)|
      rank = if index == 0
        1
      elsif standing[:correct_picks] < sorted_scores[index - 1][:correct_picks]
        index + 1
      else
        result.last[:rank]
      end
      result << standing.merge(rank: rank)
    end
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

  # Count correct picks for a submission
  # @param submission [Submission]
  # @return [Integer]
  def count_correct_picks(submission)
    submission.picks.count do |competition_id, selected_team_id|
      selected_team_id == @scoreboard.results[competition_id]
    end
  end

  def can_catch_up?(leader, trailer)
    pick_diff = (leader[:remaining_picks].to_a - trailer[:remaining_picks].to_a).size
    leader_min = leader[:correct_picks]
    trailer_max = trailer[:correct_picks] + pick_diff
    trailer_max >= leader_min
  end
end
