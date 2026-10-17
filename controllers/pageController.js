const User = require('../models/User');
const { fmt } = require('../config/format');

const home = (req, res) => {
  if (req.session.userId) return res.redirect(req.session.role === 'admin' ? '/admin' : '/intern');
  res.render('welcome', { title: 'Welcome' });
};

const login = (req, res) => {
  if (req.session.userId) return res.redirect(req.session.role === 'admin' ? '/admin' : '/intern');
  res.render('login', { title: 'Log in' });
};

// There is no public registration any more — a supervisor creates every
// intern account (see POST /api/auth/create-intern). Anyone who still has
// this URL bookmarked or indexed just lands on the login page.
const register = (req, res) => res.redirect('/login');

const forgotPage = (req, res) => {
  res.render('forgotPassword', { title: 'Reset your password' });
};

const resetPage = (req, res) => {
  res.render('resetPassword', { title: 'Choose a new password', token: req.params.token });
};

/* GET /account — account details plus change password, for anyone already
   logged in (either role) */
const account = async (req, res) => {
  try {
    const me = await User.findById(req.session.userId).populate('supervisor', 'name');
    if (!me) return req.session.destroy(() => res.redirect('/login'));
    res.render('account', {
      title: 'Account',
      user: { role: req.session.role },
      currentPath: req.path,
      me: {
        name: me.name, email: me.email, role: me.role, supervisorName: me.supervisor?.name || null,
        startFormatted: me.internshipStartDate ? fmt(me.internshipStartDate) : null,
        endFormatted: me.internshipEndDate ? fmt(me.internshipEndDate) : null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
  }
};

module.exports = { home, login, register, forgotPage, resetPage, account };
