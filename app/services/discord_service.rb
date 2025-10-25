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
    send_direct_message(user.discord_user_id, build_submission_link_message(user, week))
  end

  private

  def auth_headers
    {
      "Authorization" => "Bot #{@bot_token}",
      "Content-Type" => "application/json"
    }
  end

  def build_submission_link_message(user, week)
    <<~MESSAGE
      Hi, #{user.discord_username}

      Pick-em week #{week} is here!

      [Submit your picks here](#{Rails.application.routes.url_helpers.new_submission_url(token: user.weekly_token(week))})
    MESSAGE
  end
end
