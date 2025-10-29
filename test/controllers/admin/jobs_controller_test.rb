require "test_helper"

class Admin::JobsControllerTest < ActionDispatch::IntegrationTest
  setup do
    @admin_user = User.create!(discord_user_id: "admin456", discord_username: "AdminUser", admin: true)
    @regular_user = User.create!(discord_user_id: "user456", discord_username: "RegularUser", admin: false)
  end

  test "admin can access jobs index" do
    post_via_redirect(admin_jobs_url, session: { user_id: @admin_user.id })
    get admin_jobs_url
    assert_response :success
  end

  test "non-admin cannot access jobs index" do
    post_via_redirect(admin_jobs_url, session: { user_id: @regular_user.id })
    get admin_jobs_url
    assert_response :forbidden
  end

  test "unauthenticated user cannot access jobs index" do
    get admin_jobs_url
    assert_response :unauthorized
  end

  test "admin can create job" do
    post_via_redirect(admin_jobs_url, session: { user_id: @admin_user.id })
    assert_difference "SolidQueue::Job.count", 1 do
      post admin_jobs_url, params: { job_type: "deliver_standings", week: 1 }
    end
    assert_redirected_to admin_jobs_url
  end

  test "non-admin cannot create job" do
    post_via_redirect(admin_jobs_url, session: { user_id: @regular_user.id })
    post admin_jobs_url, params: { job_type: "deliver_standings", week: 1 }
    assert_response :forbidden
  end
end
