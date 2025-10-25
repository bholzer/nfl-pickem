class User < ApplicationRecord
  has_many :submissions, dependent: :destroy

  validates :discord_user_id, presence: true, uniqueness: true
  validates :discord_username, presence: true
end
