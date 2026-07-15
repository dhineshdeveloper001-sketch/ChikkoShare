import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FiSend, FiDownload } from 'react-icons/fi';
import { connectSocket } from '../services/socket';
import { useRoomStore } from '../store/roomStore';

const Home: React.FC = () => {
  const isConnected = useRoomStore((s) => s.isSignalingConnected);

  useEffect(() => {
    connectSocket();
  }, []);

  return (
    <div className="flex flex-col items-center justify-center flex-1 min-h-[70vh]">
      <motion.div
        className="flex flex-col items-center w-full max-w-sm"
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
      >
        {/* Logo mark */}
        <motion.div
          className="w-20 h-20 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center mb-8 shadow-[0_0_40px_rgba(99,102,241,0.35)]"
          initial={{ scale: 0.8 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.1, type: 'spring', stiffness: 200 }}
        >
          <FiSend className="text-white text-3xl -rotate-12" />
        </motion.div>

        <h1 className="text-4xl font-extrabold tracking-tight text-white mb-2 text-center">
          ChikkoShare
        </h1>
        <p className="text-slate-400 text-base mb-10 text-center">
          Fast. Secure. No limits.
        </p>

        {/* Main action buttons */}
        <div className="flex flex-col gap-4 w-full">
          <Link to="/send" className="w-full">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              className="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-2xl font-bold text-lg shadow-lg shadow-blue-900/40 transition-colors"
            >
              <FiSend className="text-xl" />
              Send Files
            </motion.button>
          </Link>

          <Link to="/receive" className="w-full">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              className="w-full flex items-center justify-center gap-3 bg-slate-800 hover:bg-slate-700 text-white py-4 rounded-2xl font-bold text-lg border border-slate-700/60 transition-colors"
            >
              <FiDownload className="text-xl" />
              Receive Files
            </motion.button>
          </Link>
        </div>

        {/* Connection status */}
        <div className="mt-8 flex items-center gap-2 text-sm">
          <span className={`w-2 h-2 rounded-full transition-colors ${isConnected ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-slate-600'}`} />
          <span className={isConnected ? 'text-emerald-400' : 'text-slate-500'}>
            {isConnected ? 'Connected' : 'Connecting...'}
          </span>
        </div>
      </motion.div>
    </div>
  );
};

export default Home;
