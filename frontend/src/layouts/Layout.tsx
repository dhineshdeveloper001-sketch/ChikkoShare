import React from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import { FiShare2, FiHome, FiSend, FiDownload, FiClock } from 'react-icons/fi';
import { motion } from 'framer-motion';

const Layout: React.FC = () => {
  const location = useLocation();

  const navItems = [
    { path: '/', label: 'Home', icon: <FiHome /> },
    { path: '/send', label: 'Send', icon: <FiSend /> },
    { path: '/receive', label: 'Receive', icon: <FiDownload /> },
    { path: '/dashboard', label: 'History', icon: <FiClock /> },
  ];

  return (
    <div className="min-h-screen flex flex-col text-slate-100 font-sans relative overflow-hidden bg-slate-950">
      {/* Background gradients for modern aesthetic */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-blue-600/20 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-purple-600/20 blur-[120px] pointer-events-none" />

      {/* Navbar */}
      <header className="sticky top-0 z-50 glass-panel border-x-0 border-t-0 rounded-none bg-slate-900/70">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="p-2 bg-blue-500 rounded-lg group-hover:bg-blue-400 transition-colors">
              <FiShare2 className="text-white text-xl" />
            </div>
            <span className="font-bold text-xl tracking-tight bg-gradient-to-r from-blue-400 to-purple-400 bg-clip-text text-transparent">
              CHIKKO SHARE
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {navItems.map((item) => {
              const isActive = location.pathname === item.path;
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={`px-4 py-2 rounded-xl flex items-center gap-2 text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-blue-500/10 text-blue-400'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  {item.icon}
                  {item.label}
                  {isActive && (
                    <motion.div
                      layoutId="nav-pill"
                      className="absolute inset-0 border border-blue-500/20 rounded-xl bg-blue-500/5 -z-10"
                      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                    />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 flex flex-col relative z-10">
        <Outlet />
      </main>
      
      {/* Footer */}
      <footer className="py-6 text-center text-slate-500 text-sm glass-panel border-x-0 border-b-0 rounded-none">
        <p>CHIKKO SHARE &copy; {new Date().getFullYear()}. Fast. Secure. Peer-to-Peer.</p>
      </footer>
    </div>
  );
};

export default Layout;
