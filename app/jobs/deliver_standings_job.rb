class DeliverStandingsJob < ApplicationJob
  queue_as :default

  def perform(week = nil)
    week ||= EspnScoreboard.current_week
    game_group_detector = GameGroupDetector.new(EspnScoreboard.new(week: week))
    completed_groups = game_group_detector.completed_groups

    # No standings to deliver yet
    return if completed_groups.empty?

    # Standings for this week and group have already been delivered
    # or the winner has already been determined and delivered
    delivered_cache_key = "standings_delivered_#{week}_#{completed_groups.join("_")}"
    delivered_winner_cache_key = "standings_delivered_winner_#{week}"
    if Rails.cache.exist?(delivered_cache_key) || Rails.cache.exist?(delivered_winner_cache_key)
      Rails.logger.info("Skipping standings delivery, already delivered or winner already determined")
      return
    end

    # Deliver standings to Discord
    DiscordService.new.send_standings(week)

    # Cache the standings delivery state
    Rails.cache.write(delivered_cache_key, true, expires_in: 1.week)
    winners = ScoringService.new(week: week).standings.select { |s| s[:winner] }
    if winners.any?
      Rails.cache.write(delivered_winner_cache_key, true, expires_in: 1.week)
    end
  end
end
