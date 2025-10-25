class DeliverHashesJob < ApplicationJob
  queue_as :default

  def perform(week = nil)
    week ||= EspnScoreboard.current_week
    DiscordService.new.send_hashes(week)
  end
end
