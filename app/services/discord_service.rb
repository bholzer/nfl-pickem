class DiscordService
  include HTTParty
  base_uri "https://discord.com/api/v10"

  def initialize
    @bot_token = Rails.application.credentials.dig(:discord, :bot_token)
    raise "Discord bot token not configured" unless @bot_token
  end

  # Get all non-bot members from a guild
  # @param guild_id [String] Discord guild (server) ID
  # @return [Array<Hash>] Array of member data
  def fetch_guild_members(guild_id)
    response = self.class.get(
      "/guilds/#{guild_id}/members",
      query: { limit: 1000 },
      headers: auth_headers
    )

    return [] unless response.success?

    response.parsed_response.reject { |m| m["user"]["bot"] }.map do |member|
      {
        id: member["user"]["id"],
        username: member["nick"] || member["user"]["global_name"] || member["user"]["username"],
        discriminator: member["user"]["discriminator"]
      }
    end
  rescue StandardError => e
    Rails.logger.error("Failed to fetch guild members: #{e.message}")
    []
  end

  # Send a direct message to a user
  # First creates a DM channel, then sends the message
  # @param user_id [String] Discord user ID
  # @param message [String] Message content
  # @return [Boolean] True if message sent successfully
  def send_direct_message(user_id, message)
    # Create DM channel
    dm_response = self.class.post(
      "/users/@me/channels",
      headers: auth_headers,
      body: { recipient_id: user_id }.to_json
    )

    return false unless dm_response.success?

    channel_id = dm_response.parsed_response["id"]

    # Send message to DM channel
    message_response = self.class.post(
      "/channels/#{channel_id}/messages",
      headers: auth_headers,
      body: { content: message }.to_json
    )

    message_response.success?
  rescue StandardError => e
    Rails.logger.error("Failed to send DM to #{user_id}: #{e.message}")
    false
  end

  # Send a message to a channel
  # @param channel_id [String] Discord channel ID
  # @param message [String] Message content
  # @return [Boolean] True if message sent successfully
  def send_channel_message(channel_id, message)
    response = self.class.post(
      "/channels/#{channel_id}/messages",
      headers: auth_headers,
      body: { content: message }.to_json
    )

    response.success?
  rescue StandardError => e
    Rails.logger.error("Failed to send message to channel #{channel_id}: #{e.message}")
    false
  end

  def send_submission_link(user, week)
    return unless user.discord_user_id.present?
    url = Rails.application.routes.url_helpers.new_submission_url(token: user.weekly_token(week))
    send_direct_message(
      user.discord_user_id,
      render_message("submission_link", url: url, week: week, name: user.discord_username)
    )
  end

  def send_standings(week)
    standings = ScoringService.new(week: week).standings
    return unless standings.any?

    send_direct_message(
      test_user_id,
      render_message("standings", standings: standings, week: week)
    )
  end

  def send_hashes(week)
    send_direct_message(
      test_user_id,
      render_message("hashes", submissions: Submission.where(week: week), week: week)
    )
  end

  private

  def render_message(template, locals = {})
    ApplicationController.render(
      template: "discord_messages/#{template}",
      locals: locals,
      layout: false
    )
  end

  def auth_headers
    {
      "Authorization" => "Bot #{@bot_token}",
      "Content-Type" => "application/json"
    }
  end

  def test_user_id
    User.find(1).discord_user_id
  end
end
