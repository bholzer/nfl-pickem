import { Controller } from "@hotwired/stimulus"

// Connects to data-controller="dark-mode"
export default class extends Controller {
  connect() {
    console.log('Dark mode controller connected')

    // Check localStorage for saved theme preference
    const savedTheme = localStorage.getItem('theme')

    if (savedTheme === 'dark' || savedTheme === 'light') {
      this.setTheme(savedTheme)
    } else {
      // Use system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      this.setTheme(prefersDark ? 'dark' : 'light', false) // Don't save system preference
    }

    // Listen for system preference changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      // Only update if user hasn't set a manual preference
      if (!localStorage.getItem('theme')) {
        this.setTheme(e.matches ? 'dark' : 'light', false)
      }
    })
  }

  toggle() {
    console.log('Toggle called')
    const currentTheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark'
    console.log(`Switching from ${currentTheme} to ${newTheme}`)
    this.setTheme(newTheme, true)
  }

  setTheme(theme, save = true) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark')
    } else {
      document.documentElement.classList.remove('dark')
    }

    if (save) {
      localStorage.setItem('theme', theme)
    }
  }
}
