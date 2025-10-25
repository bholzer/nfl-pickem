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

  private

  def auth_headers
    {
      "Authorization" => "Bot #{@bot_token}",
      "Content-Type" => "application/json"
    }
  end

  # Send weekly pick'em announcement with submission links
  # @param guild_id [String] Discord guild ID
  # @param week [Integer] NFL week number
  # @param base_url [String] Base URL for the application
  # @return [Integer] Number of DMs sent successfully
  def send_weekly_announcements(guild_id, week, base_url)
    members = fetch_guild_members(guild_id)
    sent_count = 0

    members.each do |member|
      # Create or find user in database
      user = User.find_or_create_by(discord_user_id: member[:id]) do |u|
        u.discord_username = member[:username]
      end

      # Generate JWT token for this user and week
      token = JwtService.generate_submission_token(
        user_id: user.discord_user_id,
        username: user.discord_username,
        week: week
      )

      # Build submission URL
      submission_url = "#{base_url}/picks/new?token=#{token}"

      # Send DM with personalized link
      message = build_announcement_message(week, submission_url)
      sent_count += 1 if send_direct_message(member[:id], message)
    end

    sent_count
  end

  # Post weekly scores to a channel
  # @param channel_id [String] Discord channel ID
  # @param week [Integer] NFL week number
  # @param standings [Array<Hash>] Array of user standings
  # @return [Boolean] True if posted successfully
  def post_weekly_scores(channel_id, week, standings)
    message = build_scores_message(week, standings)
    send_channel_message(channel_id, message)
  end

  private

  # Build the announcement message for pick submission
  # @param week [Integer] NFL week number
  # @param url [String] Submission URL
  # @return [String] Formatted message
  def build_announcement_message(week, url)
    <<~MESSAGE
      **NFL Pick'em - Week #{week}**

      It's time to submit your picks for Week #{week}!

      Click the link below to make your selections:
      #{url}

      Remember to submit your picks before the first game starts. Good luck!
    MESSAGE
  end

  # Build the scores message for weekly results
  # @param week [Integer] NFL week number
  # @param standings [Array<Hash>] Array of user standings with :username and :correct_picks
  # @return [String] Formatted message
  def build_scores_message(week, standings)
    message = "**Week #{week} Results**\n\n"

    standings.sort_by { |s| -s[:correct_picks] }.each_with_index do |standing, index|
      rank = index + 1
      medal = rank == 1 ? "🥇" : (rank == 2 ? "🥈" : (rank == 3 ? "🥉" : "  "))
      message += "#{medal} #{rank}. **#{standing[:username]}** - #{standing[:correct_picks]} correct\n"
    end

    message
  end
end
