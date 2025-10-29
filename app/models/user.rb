class User < ApplicationRecord
  has_many :submissions, dependent: :destroy

  validates :discord_user_id, presence: true, uniqueness: true
  validates :discord_username, presence: true

  def weekly_token(week)
    JwtService.generate_submission_token(user_id: discord_user_id, username: discord_username, week: week)
  end
end
