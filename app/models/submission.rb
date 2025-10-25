class Submission < ApplicationRecord
  belongs_to :user

  validates :week, presence: true, uniqueness: { scope: :user_id }
  validates :tiebreaker, presence: true, numericality: { only_integer: true, greater_than_or_equal_to: 0 }
  validates :picks, presence: true
end
