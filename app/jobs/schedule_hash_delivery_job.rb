class ScheduleHashDeliveryJob < ApplicationJob
  queue_as :default

  def perform(week = nil)
    week ||= EspnScoreboard.current_week
    earliest_game_time = EspnScoreboard.new(week: week).earliest_game_time
    DeliverHashesJob.set(wait_until: earliest_game_time).perform_later(week)
  end
end
