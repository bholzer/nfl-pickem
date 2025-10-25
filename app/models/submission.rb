class Submission < ApplicationRecord
  belongs_to :user

  validates :week, presence: true, uniqueness: { scope: :user_id }
  validates :tiebreaker, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :picks, presence: true

  def summary(scoreboard: EspnScoreboard.new(week: week))
    picks_summary = picks.map do |competition_id, selected_team_id|
      game = scoreboard.games.find { |g| g[:competition_id] == competition_id }
      selected_team = [ game[:home_team], game[:away_team] ].find { |t| t[:id] == selected_team_id }
      "#{game[:home_team][:name]}/#{game[:away_team][:name]}: #{selected_team[:name]}"
    end.join("\n")

    <<~SUMMARY.strip
      #{user.discord_username}
      #{picks_summary}
      Tiebreaker: #{tiebreaker}
    SUMMARY
  end

  def hash
    Digest::SHA256.hexdigest(summary)
  end
end
