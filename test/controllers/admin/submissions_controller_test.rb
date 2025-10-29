require "test_helper"

class Admin::SubmissionsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @admin_user = User.create!(discord_user_id: "admin123", discord_username: "AdminUser", admin: true)
    @regular_user = User.create!(discord_user_id: "user123", discord_username: "RegularUser", admin: false)
    @submission = Submission.create!(user: @regular_user, week: 1, picks: {}, tiebreaker: 42)
  end

  test "admin can access submissions index" do
    post_via_redirect(admin_submissions_url, session: { user_id: @admin_user.id })
    get admin_submissions_url(week: 1)
    assert_response :success
  end

  test "non-admin cannot access submissions index" do
    post_via_redirect(admin_submissions_url, session: { user_id: @regular_user.id })
    get admin_submissions_url(week: 1)
    assert_response :forbidden
  end

  test "unauthenticated user cannot access submissions index" do
    get admin_submissions_url(week: 1)
    assert_response :unauthorized
  end

  test "admin can view individual submission" do
    post_via_redirect(admin_submission_url(@submission), session: { user_id: @admin_user.id })
    get admin_submission_url(@submission)
    assert_response :success
  end

  test "non-admin cannot view individual submission" do
    post_via_redirect(admin_submission_url(@submission), session: { user_id: @regular_user.id })
    get admin_submission_url(@submission)
    assert_response :forbidden
  end
end
