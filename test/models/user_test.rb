require "test_helper"

class UserTest < ActiveSupport::TestCase
  test "user is not admin by default" do
    user = User.create!(discord_user_id: "123", discord_username: "TestUser")
    assert_not user.admin?
  end

  test "user can be created as admin" do
    user = User.create!(discord_user_id: "456", discord_username: "AdminUser", admin: true)
    assert user.admin?
  end

  test "admin? returns correct boolean value" do
    regular_user = User.create!(discord_user_id: "789", discord_username: "RegularUser", admin: false)
    admin_user = User.create!(discord_user_id: "101112", discord_username: "AdminUser", admin: true)

    assert_not regular_user.admin?
    assert admin_user.admin?
  end
end
