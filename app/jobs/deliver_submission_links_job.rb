class DeliverSubmissionLinksJob < ApplicationJob
  queue_as :default

  def perform(week = nil)
    week ||= EspnScoreboard.current_week + 1
    discord = DiscordService.new
    User.where.not(discord_user_id: nil).each do |user|
      discord.send_submission_link(user, week)
    end
  end
end
