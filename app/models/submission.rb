class Submission < ApplicationRecord
  belongs_to :user

  validates :week, presence: true, uniqueness: { scope: :user_id }
  validates :tiebreaker, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :picks, presence: true

  def summary(scoreboard: EspnScoreboard.new(week: week))
    sorted_games = scoreboard.games.sort_by { |g| [ g[:date], g[:competition_id] ] }

    picks_summary = sorted_games.map do |game|
      selected_team = [ game[:home_team], game[:away_team] ].find { |t| t[:id] == picks[game[:competition_id]] }
      next if selected_team.nil?
      "#{game[:name]}: #{selected_team[:name]}"
    end.compact.join("\n")

    <<~SUMMARY.strip
      #{user.discord_username}
      #{picks_summary}
      Tiebreaker: #{tiebreaker}
    SUMMARY
  end

  def verification_hash
    Digest::SHA256.hexdigest(summary)
  end
end
