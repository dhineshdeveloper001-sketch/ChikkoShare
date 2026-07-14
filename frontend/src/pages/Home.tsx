import React from 'react';
import { Link } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import { FiSend, FiDownload, FiShield, FiZap, FiSmartphone, FiGlobe } from 'react-icons/fi';

const Home: React.FC = () => {
  const containerVariants: Variants = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.1 } }
  };

  const itemVariants: Variants = {
    hidden: { y: 20, opacity: 0 },
    visible: { y: 0, opacity: 1, transition: { type: 'spring', stiffness: 100 } }
  };

  const features = [
    { icon: <FiZap className="text-yellow-400" />, title: 'Lightning Fast', desc: 'Direct WebRTC connection. No server throttling. Up to 300+ MB/s.' },
    { icon: <FiShield className="text-emerald-400" />, title: 'Secure & Private', desc: 'End-to-end DTLS encryption. We never see or store your files.' },
    { icon: <FiGlobe className="text-blue-400" />, title: 'Browser Based', desc: 'No installation required. Works on Chrome, Safari, Edge, Firefox.' },
    { icon: <FiSmartphone className="text-purple-400" />, title: 'Cross Platform', desc: 'Seamlessly transfer files between Phone, Tablet, and Desktop.' },
  ];

  return (
    <div className="flex flex-col items-center justify-center flex-1 py-12">
      <motion.div 
        className="text-center max-w-3xl"
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6 }}
      >
        <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight mb-6">
          <span className="bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent">Share files</span><br />
          <span className="bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">without limits.</span>
        </h1>
        <p className="text-lg md:text-xl text-slate-400 mb-10 max-w-2xl mx-auto">
          Production-grade peer-to-peer file transfer. No size limits. No logins. Just fast, secure sharing directly between devices.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4 mb-20">
          <Link to="/send">
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white px-8 py-4 rounded-2xl font-semibold text-lg shadow-lg shadow-blue-900/50 transition-colors w-full sm:w-auto justify-center"
            >
              <FiSend className="text-xl" />
              Send Files
            </motion.button>
          </Link>
          
          <Link to="/receive">
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="flex items-center gap-3 bg-slate-800 hover:bg-slate-700 text-white px-8 py-4 rounded-2xl font-semibold text-lg shadow-lg shadow-slate-900/50 border border-slate-700 transition-colors w-full sm:w-auto justify-center"
            >
              <FiDownload className="text-xl" />
              Receive Files
            </motion.button>
          </Link>
        </div>
      </motion.div>

      <motion.div 
        className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-5xl"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {features.map((f, i) => (
          <motion.div key={i} variants={itemVariants} className="glass-panel p-6 hover:bg-slate-800/80 transition-colors cursor-default">
            <div className="flex items-start gap-4">
              <div className="p-3 bg-slate-900/50 rounded-xl text-2xl border border-slate-700/50">
                {f.icon}
              </div>
              <div>
                <h3 className="text-xl font-bold text-slate-200 mb-2">{f.title}</h3>
                <p className="text-slate-400">{f.desc}</p>
              </div>
            </div>
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
};

export default Home;
