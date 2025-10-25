class GameGroupDetector
  def initialize(scoreboard)
    @scoreboard = scoreboard
  end

  # Define natural broadcast windows (Central Time)
  def groups
    games = @scoreboard.games

    {
      thursday: games.select { |g| g[:date].thursday? },
      sunday_early: games.select { |g| g[:date].sunday? && g[:date].hour < 14 },
      sunday_late: games.select { |g| g[:date].sunday? && g[:date].hour.between?(14, 17) },
      sunday_night: games.select { |g| g[:date].sunday? && g[:date].hour >= 1 },
      monday: games.select { |g| g[:date].monday? }
    }.reject { |_, games| games.empty? }
  end

  def completed_groups
    groups.select do |name, games|
      games.all? { |g| g[:status] == "STATUS_FINAL" }
    end.keys.sort
  end
end
