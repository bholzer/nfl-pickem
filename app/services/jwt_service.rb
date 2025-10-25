class JwtService
  SECRET_KEY = Rails.application.credentials.secret_key_base

  # Generate a JWT token for a user and week
  # @param user_id [String] Discord user ID
  # @param username [String] Discord username
  # @param week [Integer] NFL week number
  # @param expires_in [Integer] Expiration time in seconds (default: 365 days)
  # @return [String] Encoded JWT token
  def self.encode(user_id:, username:, week:, expires_in: 365.days.to_i)
    payload = {
      user_id: user_id,
      username: username,
      week: week,
      exp: Time.now.to_i + expires_in
    }

    JWT.encode(payload, SECRET_KEY, "HS256")
  end

  # Decode and verify a JWT token
  # @param token [String] JWT token to decode
  # @return [Hash, nil] Decoded payload or nil if invalid/expired
  def self.decode(token)
    decoded = JWT.decode(token, SECRET_KEY, true, { algorithm: "HS256" })
    decoded.first.with_indifferent_access
  rescue JWT::DecodeError, JWT::ExpiredSignature => e
    Rails.logger.error("JWT decode error: #{e.message}")
    nil
  end

  # Verify a token and return the payload if valid
  # @param token [String] JWT token to verify
  # @return [Hash, nil] Payload if valid, nil otherwise
  def self.verify(token)
    decode(token)
  end

  # Generate a token for pick submission (long expiry)
  # @param user_id [String] Discord user ID
  # @param username [String] Discord username
  # @param week [Integer] NFL week number
  # @return [String] Encoded JWT token valid for 365 days
  def self.generate_submission_token(user_id:, username:, week:)
    encode(user_id: user_id, username: username, week: week, expires_in: 365.days.to_i)
  end

  # Generate a token for data retrieval (short expiry)
  # @param user_id [String] Discord user ID
  # @param username [String] Discord username
  # @param week [Integer] NFL week number
  # @return [String] Encoded JWT token valid for 7 days
  def self.generate_retrieval_token(user_id:, username:, week:)
    encode(user_id: user_id, username: username, week: week, expires_in: 1.days.to_i)
  end
end
